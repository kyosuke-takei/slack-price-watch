import fs from "fs";
import path from "path";
import process from "process";

import { keepaQuery, keepaProduct } from "../services/keepa.js";
import { postSlackBatches } from "../services/slack.js";
import { getWatchlist } from "../storage/watchlist.js";

/**
 * =========================
 * env helpers
 * =========================
 */
const env = (k, d = undefined) => (process.env[k] ?? d);
const envInt = (k, d) => {
  const v = env(k);
  if (v === undefined || v === null || v === "") return d;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : d;
};
const nowId = () => `${Date.now()}`;

/**
 * =========================
 * state path (✅ fully STATE_FILE compliant)
 * - If STATE_FILE is absolute: use as-is
 * - If relative: resolve from repo root
 *   - In GitHub Actions: use GITHUB_WORKSPACE
 *   - Locally: if cwd ends with "/cloud", repo root is ".."
 * =========================
 */
function guessRepoRoot() {
  const ws = env("GITHUB_WORKSPACE");
  if (ws) return ws;

  const cwd = process.cwd();
  const base = path.basename(cwd).toLowerCase();
  // if running inside ".../slack-price-watch/cloud"
  if (base === "cloud") return path.resolve(cwd, "..");
  return cwd;
}

function resolveStateFile() {
  const raw = env("STATE_FILE", "cloud/data/state.json");
  if (path.isAbsolute(raw)) return raw;

  const root = guessRepoRoot();
  return path.resolve(root, raw);
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * =========================
 * state I/O
 * =========================
 * state shape:
 * {
 *   version: 1,
 *   updatedAt: 1768...,
 *   items: {
 *     "<ASIN>": {
 *        price: 10980,
 *        rank: 27,
 *        sellers: 103,
 *        sold30: 24,
 *        updatedAt: 1768...
 *     }
 *   }
 * }
 */
function loadState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { version: 1, updatedAt: 0, items: {} };
    const txt = fs.readFileSync(filePath, "utf8");
    if (!txt.trim()) return { version: 1, updatedAt: 0, items: {} };
    const obj = JSON.parse(txt);
    if (!obj || typeof obj !== "object") return { version: 1, updatedAt: 0, items: {} };
    if (!obj.items || typeof obj.items !== "object") obj.items = {};
    if (!obj.version) obj.version = 1;
    if (!obj.updatedAt) obj.updatedAt = 0;
    return obj;
  } catch (e) {
    console.warn(`[${nowId()}] state load failed -> reset`, e?.message ?? e);
    return { version: 1, updatedAt: 0, items: {} };
  }
}

function saveState(filePath, state) {
  ensureDirForFile(filePath);
  const out = JSON.stringify(state, null, 2);
  fs.writeFileSync(filePath, out, "utf8");
}

/**
 * =========================
 * diff logic (simple & practical)
 * =========================
 */
function diffItem(prev, curr, tuning) {
  if (!prev) return { kind: "NEW", changed: true, reasons: ["new"] };

  const reasons = [];

  if (Math.abs((curr.price ?? 0) - (prev.price ?? 0)) >= tuning.PRICE_DELTA_YEN) {
    reasons.push(`price ${prev.price}→${curr.price}`);
  }
  if (Math.abs((curr.rank ?? 0) - (prev.rank ?? 0)) >= tuning.RANK_DELTA_ABS) {
    reasons.push(`rank ${prev.rank}→${curr.rank}`);
  }
  if (Math.abs((curr.sellers ?? 0) - (prev.sellers ?? 0)) >= tuning.SELLERS_DELTA_ABS) {
    reasons.push(`sellers ${prev.sellers}→${curr.sellers}`);
  }
  if (Math.abs((curr.sold30 ?? 0) - (prev.sold30 ?? 0)) >= tuning.SOLD30_DELTA_ABS) {
    reasons.push(`sold30 ${prev.sold30}→${curr.sold30}`);
  }

  return { kind: reasons.length ? "CHANGED" : "NO_DIFF", changed: reasons.length > 0, reasons };
}

/**
 * =========================
 * profile runner
 * =========================
 * - Notifies up to MAX_NOTIFY_PER_PROFILE per profile
 * - Still processes other profiles even if one hits max
 * =========================
 */
async function runProfile(profileKey, state, opts) {
  const runTag = nowId();
  console.log(`[${runTag}] profile START ${opts.profileLabel}`);

  const watchlist = await getWatchlist(profileKey);

  // Step 1: find candidates (ASIN list)
  // keepaQuery is assumed to return array of ASINs or products with asin field.
  const candidates = await keepaQuery(profileKey, {
    perPage: opts.FINDER_PER_PAGE,
    maxPages: opts.FINDER_MAX_PAGES,
    strict: opts.STRICT_FINDER === "on",
  });

  const asinList = (candidates || [])
    .map((x) => (typeof x === "string" ? x : x?.asin))
    .filter(Boolean);

  // Optional: apply watchlist intersection if you use it
  const filteredAsins = watchlist?.length
    ? asinList.filter((a) => watchlist.includes(a))
    : asinList;

  // Step 2: fetch product details
  let picked = 0;
  let scanned = 0;
  let notified = 0;
  const notifications = [];

  for (const asin of filteredAsins) {
    if (notified >= opts.MAX_NOTIFY_PER_PROFILE) break;

    scanned += 1;

    // keepaProduct is assumed to return a product snapshot:
    // { asin, title, image, amazonUrl, keepaUrl, price, rank, sellers, sold30, categoryLabel }
    const p = await keepaProduct(profileKey, asin);

    if (!p) continue;

    // ✅ price floor: do not save to state if below min, and do not notify
    if ((p.price ?? 0) < opts.MIN_PRICE_YEN) {
      continue;
    }

    picked += 1;

    const prev = state.items[asin];
    const d = diffItem(prev, p, opts.tuning);

    // cooldown is handled outside or via state timestamps; minimal here
    if (d.changed) {
      notified += 1;
      notifications.push({
        profileKey,
        profileLabel: opts.profileLabel,
        asin: p.asin ?? asin,
        title: p.title ?? "",
        image: p.image ?? "",
        amazonUrl: p.amazonUrl ?? "",
        keepaUrl: p.keepaUrl ?? "",
        price: p.price ?? null,
        rank: p.rank ?? null,
        sellers: p.sellers ?? null,
        sold30: p.sold30 ?? null,
        diffKind: d.kind,
        diffReasons: d.reasons,
      });
    }

    // ✅ IMPORTANT: only save to state if price >= MIN_PRICE_YEN
    state.items[asin] = {
      price: p.price ?? null,
      rank: p.rank ?? null,
      sellers: p.sellers ?? null,
      sold30: p.sold30 ?? null,
      updatedAt: Date.now(),
    };
  }

  console.log(
    `[${runTag}] profile DONE ${opts.profileLabel} notified=${notified} picked=${picked} scanned=${scanned} cooldownSkip=0 noDiff=0`
  );

  return { notifications, notified, picked, scanned };
}

/**
 * =========================
 * main
 * =========================
 */
async function main() {
  const runTag = nowId();

  const ONLY_PROFILE = env("ONLY_PROFILE", "all");

  const stateFile = resolveStateFile();
  ensureDirForFile(stateFile);

  let state = loadState(stateFile);
  if (!fs.existsSync(stateFile)) {
    saveState(stateFile, state);
    console.log(`[${runTag}] state file created { file: '${path.relative(guessRepoRoot(), stateFile)}' }`);
  }

  console.log(`[${runTag}] monitor START (ONLY_PROFILE=${ONLY_PROFILE})`);
  console.log(`[${runTag}] state file => ${stateFile}`);

  const opts = {
    PROFILE_LIMIT: envInt("PROFILE_LIMIT", 30),
    MAX_NOTIFY_PER_PROFILE: envInt("MAX_NOTIFY_PER_PROFILE", envInt("MAX_NOTIFY", 30)),
    FINDER_PER_PAGE: envInt("FINDER_PER_PAGE", 100),
    FINDER_MAX_PAGES: envInt("FINDER_MAX_PAGES", 5),
    SLACK_BATCH: envInt("SLACK_BATCH", 3),
    STRICT_FINDER: env("STRICT_FINDER", "on"),
    STRICT_CATEGORY_MATCH: env("STRICT_CATEGORY_MATCH", "on"),
    MIN_PRICE_YEN: envInt("MIN_PRICE_YEN", 0),
    tuning: {
      PRICE_DELTA_YEN: envInt("PRICE_DELTA_YEN", 200),
      RANK_DELTA_ABS: envInt("RANK_DELTA_ABS", 5000),
      SELLERS_DELTA_ABS: envInt("SELLERS_DELTA_ABS", 1),
      SOLD30_DELTA_ABS: envInt("SOLD30_DELTA_ABS", 5),
    },
  };

  const profiles = [
    { key: "toys", label: "おもちゃ" },
    { key: "games", label: "ゲーム" },
    { key: "hobby", label: "ホビー" },
  ];

  const targets =
    ONLY_PROFILE === "all" || !ONLY_PROFILE
      ? profiles
      : profiles.filter((p) => p.key === ONLY_PROFILE);

  const allNotifs = [];
  let totalNotified = 0;

  for (const p of targets) {
    const r = await runProfile(p.key, state, {
      ...opts,
      profileLabel: p.label,
    });

    totalNotified += r.notified;
    allNotifs.push(...r.notifications);
  }

  // Save state once at end (after all profiles)
  state.updatedAt = Date.now();

  saveState(stateFile, state);
  const asinCount = Object.keys(state.items || {}).length;

  console.log(
    `[${runTag}] state saved { file: '${path.relative(guessRepoRoot(), stateFile)}', asinCount: ${asinCount}, pruned: 0 }`
  );

  // Slack post
  if (allNotifs.length) {
    await postSlackBatches(allNotifs, { batchSize: opts.SLACK_BATCH });
  }

  console.log(`[${runTag}] monitor DONE { notified: ${totalNotified} }`);
}

main().catch((e) => {
  console.error(`[${nowId()}] monitor ERROR`, e);
  process.exit(1);
});
