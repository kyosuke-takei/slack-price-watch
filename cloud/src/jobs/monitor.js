// cloud/src/jobs/monitor.js
// Slack Price Monitor (cloud)
// - STATE_FILE persisted via GitHub Actions cache
// - Notify only when diff exceeds thresholds (or NEW)
// - Skip < MIN_PRICE_YEN at fetch stage (not stored, not notified)
// - Per-profile notify limit: MAX_NOTIFY_PER_PROFILE
// - 429 Too Many Requests: wait refillIn then retry
// - Slack payload: { text, blocks } using existing slack() exporter
// - Slack shows readable diffs with arrows

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { keepaQuery, keepaProduct, keepaProductPageUrl } from "../services/keepa.js";
import { slack } from "../services/slack.js";

/* =========================
 * env
 * ========================= */
const FINDER_PER_PAGE = numEnv("FINDER_PER_PAGE", 100);
const FINDER_MAX_PAGES = numEnv("FINDER_MAX_PAGES", 5);
const SLACK_BATCH = clamp(numEnv("SLACK_BATCH", 1), 1, 3);

const PROFILE_LIMIT = numEnv("PROFILE_LIMIT", 30);
const MAX_NOTIFY_PER_PROFILE = numEnv("MAX_NOTIFY_PER_PROFILE", 30);

const DOMAIN = Number(process.env.KEEPA_DOMAIN || 5); // 5=JP
const ONLY_PROFILE = (process.env.ONLY_PROFILE || "all").trim().toLowerCase();

// diff tuning
const MIN_PRICE_YEN = numEnv("MIN_PRICE_YEN", 2000);
const PRICE_DELTA_YEN = numEnv("PRICE_DELTA_YEN", 200);
const RANK_DELTA_ABS = numEnv("RANK_DELTA_ABS", 5000);
const SELLERS_DELTA_ABS = numEnv("SELLERS_DELTA_ABS", 1);
const SOLD30_DELTA_ABS = numEnv("SOLD30_DELTA_ABS", 5);
const NOTIFY_COOLDOWN_HOURS = numEnv("NOTIFY_COOLDOWN_HOURS", 6);

// state
const STATE_FILE_RAW = (process.env.STATE_FILE || "cloud/data/state.json").trim();
const STATE_TTL_DAYS = numEnv("STATE_TTL_DAYS", 30);

/* =========================
 * profiles
 * ========================= */
const PROFILES = [
  { key: "toys", name: "おもちゃ", rootCategory: 13299531, excludeDigital: false },
  { key: "games", name: "ゲーム", rootCategory: 637394, excludeDigital: true },
  { key: "hobby", name: "ホビー", rootCategory: 2277721051, excludeDigital: false },
];

const DIGITAL_KEYWORDS = [
  "オンラインコード",
  "オンライン コード",
  "ダウンロード",
  "download",
  "digital code",
  "ダウンロード版",
];

/* =========================
 * util
 * ========================= */
function numEnv(key, def) {
  const v = process.env[key];
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}
function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
function ts() {
  return Date.now();
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function isDigitalTitle(title = "") {
  const lower = title.toLowerCase();
  return DIGITAL_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}
function normalizeTitle(rawTitle) {
  return (rawTitle || "(no title)").replace(/\s+/g, " ").trim();
}
function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}
function yen(v) {
  if (v == null) return "-";
  return `${Number(v).toLocaleString("ja-JP")}円`;
}
function fmtSigned(n, unit = "") {
  if (n == null || !Number.isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("ja-JP")}${unit}`;
}
function arrowUpDown(delta, { invert = false } = {}) {
  // invert=true: smaller is better (rank)
  if (delta == null || !Number.isFinite(delta) || delta === 0) return "";
  const up = invert ? "🔺" : "🔺";
  const down = invert ? "🔻" : "🔻";
  // rank: delta<0 is improvement => 🔻
  if (invert) return delta < 0 ? down : up;
  return delta > 0 ? up : down;
}

/* =========================
 * STATE_FILE resolve
 * ========================= */
function guessRepoRoot() {
  const ws = process.env.GITHUB_WORKSPACE;
  if (ws) return ws;

  const cwd = process.cwd();
  const base = path.basename(cwd).toLowerCase();
  if (base === "cloud") return path.resolve(cwd, "..");
  return cwd;
}
function resolveStateFile(rawPath) {
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(guessRepoRoot(), rawPath);
}
const STATE_FILE = resolveStateFile(STATE_FILE_RAW);

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const s = fs.readFileSync(filePath, "utf8");
    if (!s.trim()) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(filePath, obj) {
  ensureDirForFile(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

/* =========================
 * state
 * ========================= */
function loadState() {
  const base = { version: 1, updatedAt: 0, asins: {} };
  const st = readJsonSafe(STATE_FILE, base);
  if (!st || typeof st !== "object") return base;
  if (!st.asins || typeof st.asins !== "object") st.asins = {};
  if (typeof st.updatedAt !== "number") st.updatedAt = 0;
  if (typeof st.version !== "number") st.version = 1;
  return st;
}

function pruneState(state) {
  const cutoff = ts() - STATE_TTL_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [asin, v] of Object.entries(state.asins)) {
    const lastSeenAt = v?.lastSeenAt ?? 0;
    if (typeof lastSeenAt === "number" && lastSeenAt > 0 && lastSeenAt < cutoff) {
      delete state.asins[asin];
      removed += 1;
    }
  }
  return removed;
}

function saveState(state) {
  state.updatedAt = ts();
  const pruned = pruneState(state);
  writeJsonAtomic(STATE_FILE, state);
  log("state saved", { file: path.relative(guessRepoRoot(), STATE_FILE), asinCount: Object.keys(state.asins).length, pruned });
}

/* =========================
 * Keepa helpers
 * ========================= */
function getStatsBasics(stats = {}) {
  const current = Array.isArray(stats.current) ? stats.current : [];
  const amazonRaw = current[0];
  const newRaw = current[1];
  const rankRaw = current[3];

  const amazonPrice = typeof amazonRaw === "number" && amazonRaw > 0 ? amazonRaw : null;
  const newPrice = typeof newRaw === "number" && newRaw > 0 ? newRaw : null;
  const salesRank = typeof rankRaw === "number" && rankRaw > 0 ? rankRaw : null;

  return { amazonPrice, newPrice, salesRank };
}

function getTotalOfferCount(stats = {}) {
  const raw = stats.totalOfferCount;
  if (typeof raw === "number" && raw >= 0) return raw;
  return null;
}

function getMainImageUrl(product = {}) {
  const csv = product.imagesCSV;
  if (!csv || typeof csv !== "string") return null;
  const firstId = csv.split(",")[0];
  if (!firstId) return null;
  return `https://m.media-amazon.com/images/I/${firstId}.jpg`;
}

/* =========================
 * 429 retry wrapper
 * ========================= */
function extractRefillInMs(message) {
  const m = String(message).match(/"refillIn"\s*:\s*(\d+)/);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

async function withRetry(fn, { label = "call", maxRetries = 8 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;

      const msg = String(err?.message || err);
      const refillIn = extractRefillInMs(msg);

      if (refillIn != null) {
        const waitMs = Math.min(refillIn + 500, 60_000);
        log(`${label}: 429 -> wait ${waitMs}ms retry ${attempt}/${maxRetries}`);
        if (attempt > maxRetries) throw err;
        await sleep(waitMs);
        continue;
      }

      const backoff = Math.min(500 * Math.pow(2, attempt - 1), 10_000);
      log(`${label}: error -> ${msg} (retry ${attempt}/${maxRetries}) backoff=${backoff}ms`);
      if (attempt > maxRetries) throw err;
      await sleep(backoff);
    }
  }
}

/* =========================
 * Finder
 * ========================= */
async function fetchAsinsForProfile(profile) {
  const asins = [];
  let page = 0;

  while (page < FINDER_MAX_PAGES) {
    const payload = {
      domainId: DOMAIN,
      rootCategory: profile.rootCategory,
      page,
      perPage: FINDER_PER_PAGE,
      sort: [["current_SALES", "asc"]],
      productType: [0, 1, 2],
    };

    const res = await withRetry(() => keepaQuery(payload), { label: `keepaQuery:${profile.key}` });
    const list = Array.isArray(res?.asinList) ? res.asinList : [];
    if (!list.length) break;

    for (const asin of list) {
      if (!asins.includes(asin)) asins.push(asin);
    }
    if (list.length < FINDER_PER_PAGE) break;
    page += 1;
  }

  return asins;
}

/* =========================
 * diff & cooldown (B: visible diffs)
 * ========================= */
function buildDiffLabel(prev, curr) {
  if (!prev) return { changed: true, label: "🆕 NEW" };

  const parts = [];

  // price
  if (curr.price != null && prev.price != null) {
    const d = curr.price - prev.price;
    if (Math.abs(d) >= PRICE_DELTA_YEN) {
      parts.push(`${arrowUpDown(d)} 価格 ${fmtSigned(d, "円")}`);
    }
  } else if (curr.price != null && prev.price == null) {
    parts.push(`🔺 価格 - → ${yen(curr.price)}`);
  } else if (curr.price == null && prev.price != null) {
    parts.push(`🔻 価格 ${yen(prev.price)} → -`);
  }

  // rank (smaller is better)
  if (curr.rank != null && prev.rank != null) {
    const d = curr.rank - prev.rank;
    if (Math.abs(d) >= RANK_DELTA_ABS) {
      // rank improved when d < 0
      parts.push(`${arrowUpDown(d, { invert: true })} ランク ${fmtSigned(d)}`);
    }
  }

  // sellers
  if (curr.sellers != null && prev.sellers != null) {
    const d = curr.sellers - prev.sellers;
    if (Math.abs(d) >= SELLERS_DELTA_ABS) {
      parts.push(`${arrowUpDown(d)} 出品者 ${fmtSigned(d)}`);
    }
  }

  // sold30
  if (curr.sold30 != null && prev.sold30 != null) {
    const d = curr.sold30 - prev.sold30;
    if (Math.abs(d) >= SOLD30_DELTA_ABS) {
      parts.push(`${arrowUpDown(d)} 30日販売 ${fmtSigned(d)}`);
    }
  }

  if (!parts.length) return { changed: false, label: "NO_DIFF" };
  return { changed: true, label: parts.join(" / ") };
}

function inCooldown(prev) {
  if (!prev?.lastNotifiedAt) return false;
  const ms = NOTIFY_COOLDOWN_HOURS * 60 * 60 * 1000;
  return ts() - prev.lastNotifiedAt < ms;
}

/* =========================
 * Slack blocks
 * ========================= */
function buildBlocks(profileName, it) {
  const blocks = [];

  const titleSection = {
    type: "section",
    text: { type: "mrkdwn", text: `*${it.title}*` },
  };

  if (it.imageUrl) {
    titleSection.accessory = {
      type: "image",
      image_url: it.imageUrl,
      alt_text: (it.title || it.asin || "").slice(0, 80),
    };
  }
  blocks.push(titleSection);

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*価格*\n${it.price != null ? yen(it.price) : "-"}` },
      { type: "mrkdwn", text: `*出品者*\n${it.sellers ?? "-"}人` },
      { type: "mrkdwn", text: `*ランキング*\n${it.rank ?? "-"}位` },
      { type: "mrkdwn", text: `*30日販売数*\n${it.sold30 ?? "-"}個` },
    ],
  });

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `変更検知: *${it.diffLabel}*` }],
  });

  blocks.push({
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: "Amazon" }, url: it.amazonUrl },
      { type: "button", text: { type: "plain_text", text: "Keepa" }, url: it.keepaUrl },
    ],
  });

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `カテゴリ: *${profileName}* / ASIN: \`${it.asin}\`` }],
  });

  blocks.push({ type: "divider" });
  return blocks;
}

async function postToSlack(profileName, items) {
  if (!items.length) return 0;

  const groups = chunk(items, SLACK_BATCH);
  let sent = 0;

  for (const group of groups) {
    const blocks = [];
    for (const it of group) blocks.push(...buildBlocks(profileName, it));
    const fallback = `${profileName}: ${group[0].title?.slice(0, 60) || group[0].asin} ほか${group.length}件`;

    try {
      await slack({ text: fallback, blocks });
      sent += group.length;
    } catch (e) {
      log(`Slack group failed (${profileName}, size=${group.length}) -> single`, e?.message || e);
      for (const it of group) {
        try {
          await slack({
            text: `${profileName}: ${it.title?.slice(0, 60) || it.asin}`,
            blocks: buildBlocks(profileName, it),
          });
          sent += 1;
        } catch (e2) {
          log(`Slack single failed (${profileName}, asin=${it.asin})`, e2?.message || e2);
        }
      }
    }
  }

  return sent;
}

/* =========================
 * main per profile
 * ========================= */
async function processProfile(profile, state) {
  log(`profile START ${profile.name}`);

  const asins = await fetchAsinsForProfile(profile);
  if (!asins.length) {
    log(`profile DONE ${profile.name} (no asins)`);
    return { sent: 0, picked: 0, scanned: 0, cooldownSkip: 0, noDiff: 0 };
  }

  const asinChunks = chunk(asins, 20);
  const pickedToNotify = [];

  let scanned = 0;
  let picked = 0;
  let cooldownSkip = 0;
  let noDiff = 0;

  for (const ch of asinChunks) {
    if (pickedToNotify.length >= MAX_NOTIFY_PER_PROFILE) break;

    let res;
    try {
      res = await withRetry(() => keepaProduct(ch, { statsDays: 90 }), {
        label: `keepaProduct:${profile.key}`,
        maxRetries: 10,
      });
    } catch (e) {
      log(`keepaProduct failed for ${profile.name} (continue)`, e?.message || e);
      continue;
    }

    const products = Array.isArray(res?.products) ? res.products : [];

    for (const p of products) {
      scanned += 1;
      if (!p?.asin) continue;

      if (profile.excludeDigital && isDigitalTitle(p.title)) continue;

      const stats = p.stats || {};
      const { amazonPrice, newPrice, salesRank } = getStatsBasics(stats);

      if (amazonPrice && amazonPrice > 0) continue;

      const sellers = getTotalOfferCount(stats);
      if (sellers == null || sellers < 3) continue;

      const monthlySold = stats.salesRankDrops30 ?? stats.salesRankDrops90 ?? stats.salesRankDrops180 ?? null;
      const price = newPrice ?? amazonPrice ?? null;

      // ✅ 取得時点で 2000円未満は弾く（stateにも保存しない）
      if (price == null || price < MIN_PRICE_YEN) continue;

      const asin = p.asin;
      const prev = state.asins[asin];
      const nowT = ts();

      const curr = {
        asin,
        title: normalizeTitle(p.title),
        price,
        sellers,
        rank: salesRank,
        sold30: monthlySold,
        amazonUrl: `https://www.amazon.co.jp/dp/${asin}`,
        keepaUrl: keepaProductPageUrl(asin),
        imageUrl: getMainImageUrl(p),
      };

      const diff = buildDiffLabel(prev, curr);

      // state更新（2000円以上だけが残る仕様）
      state.asins[asin] = {
        asin,
        title: curr.title,
        price: curr.price,
        rank: curr.rank,
        sellers: curr.sellers,
        sold30: curr.sold30,
        firstSeenAt: prev?.firstSeenAt ?? nowT,
        lastSeenAt: nowT,
        lastNotifiedAt: prev?.lastNotifiedAt ?? 0,
      };

      if (!diff.changed) {
        noDiff += 1;
        continue;
      }

      if (inCooldown(prev)) {
        cooldownSkip += 1;
        continue;
      }

      picked += 1;
      pickedToNotify.push({ ...curr, diffLabel: diff.label });

      if (pickedToNotify.length >= PROFILE_LIMIT || pickedToNotify.length >= MAX_NOTIFY_PER_PROFILE) break;
    }
  }

  let sent = 0;
  if (pickedToNotify.length) {
    sent = await postToSlack(profile.name, pickedToNotify);
    const now2 = ts();
    for (const it of pickedToNotify.slice(0, sent)) {
      if (state.asins[it.asin]) state.asins[it.asin].lastNotifiedAt = now2;
    }
  }

  log(
    `profile DONE ${profile.name} notified=${sent} picked=${picked} scanned=${scanned} cooldownSkip=${cooldownSkip} noDiff=${noDiff}`
  );

  return { sent, picked, scanned, cooldownSkip, noDiff };
}

/* =========================
 * main
 * ========================= */
async function main() {
  log(`monitor START (ONLY_PROFILE=${ONLY_PROFILE || "all"})`);
  log(`STATE_FILE=${path.relative(guessRepoRoot(), STATE_FILE)}`);

  const state = loadState();

  if (!fs.existsSync(STATE_FILE)) {
    writeJsonAtomic(STATE_FILE, state);
    log("state file created", { file: path.relative(guessRepoRoot(), STATE_FILE) });
  }

  let targets = PROFILES;
  if (ONLY_PROFILE && ONLY_PROFILE !== "all") {
    const filtered = PROFILES.filter((p) => p.key === ONLY_PROFILE);
    targets = filtered.length ? filtered : PROFILES;
  }

  let total = 0;

  for (const profile of targets) {
    const r = await processProfile(profile, state);
    total += r.sent;
  }

  saveState(state);
  log("monitor DONE", { notified: total });
}

main().catch((err) => {
  console.error("monitor FATAL", err?.message || err);
  process.exitCode = 1;
});
