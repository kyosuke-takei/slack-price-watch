import fs from "fs";
import path from "path";
import process from "process";

import { keepaQuery, keepaProduct } from "../services/keepa.js";
import { postSlackBatches } from "../services/slack.js";

/* =========================
 * env helpers
 * ========================= */
const env = (k, d = undefined) => (process.env[k] ?? d);
const envInt = (k, d) => {
  const v = env(k);
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const now = () => Date.now();

/* =========================
 * STATE_FILE resolve
 * ========================= */
function repoRoot() {
  if (process.env.GITHUB_WORKSPACE) return process.env.GITHUB_WORKSPACE;
  if (process.cwd().endsWith("/cloud")) return path.resolve(process.cwd(), "..");
  return process.cwd();
}

function resolveStateFile() {
  const raw = env("STATE_FILE", "cloud/data/state.json");
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(repoRoot(), raw);
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/* =========================
 * state io
 * ========================= */
function loadState(file) {
  if (!fs.existsSync(file)) return { items: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { items: {} };
  }
}

function saveState(file, state) {
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

/* =========================
 * diff
 * ========================= */
function hasDiff(prev, curr, t) {
  if (!prev) return true;
  if (Math.abs((curr.price ?? 0) - (prev.price ?? 0)) >= t.PRICE_DELTA_YEN) return true;
  if (Math.abs((curr.rank ?? 0) - (prev.rank ?? 0)) >= t.RANK_DELTA_ABS) return true;
  if (Math.abs((curr.sellers ?? 0) - (prev.sellers ?? 0)) >= t.SELLERS_DELTA_ABS) return true;
  if (Math.abs((curr.sold30 ?? 0) - (prev.sold30 ?? 0)) >= t.SOLD30_DELTA_ABS) return true;
  return false;
}

/* =========================
 * main
 * ========================= */
async function main() {
  const stateFile = resolveStateFile();
  let state = loadState(stateFile);

  if (!fs.existsSync(stateFile)) {
    saveState(stateFile, state);
    console.log("state file created", stateFile);
  }

  console.log("monitor START");

  const MIN_PRICE = envInt("MIN_PRICE_YEN", 2000);
  const MAX_NOTIFY = envInt("MAX_NOTIFY_PER_PROFILE", 30);

  const tuning = {
    PRICE_DELTA_YEN: envInt("PRICE_DELTA_YEN", 200),
    RANK_DELTA_ABS: envInt("RANK_DELTA_ABS", 5000),
    SELLERS_DELTA_ABS: envInt("SELLERS_DELTA_ABS", 1),
    SOLD30_DELTA_ABS: envInt("SOLD30_DELTA_ABS", 5),
  };

  const profiles = [
    { key: "toys", label: "おもちゃ" },
    { key: "games", label: "ゲーム" },
    { key: "hobby", label: "ホビー" },
  ];

  const allNotifs = [];

  for (const profile of profiles) {
    let notified = 0;
    console.log(`profile START ${profile.label}`);

    const asins = await keepaQuery(profile.key);

    for (const asin of asins) {
      if (notified >= MAX_NOTIFY) break;

      const p = await keepaProduct(profile.key, asin);
      if (!p || (p.price ?? 0) < MIN_PRICE) continue;

      const prev = state.items[asin];
      if (!hasDiff(prev, p, tuning)) continue;

      notified++;
      allNotifs.push({ ...p, profile: profile.label });

      state.items[asin] = {
        price: p.price,
        rank: p.rank,
        sellers: p.sellers,
        sold30: p.sold30,
        updatedAt: now(),
      };
    }

    console.log(`profile DONE ${profile.label} notified=${notified}`);
  }

  saveState(stateFile, state);
  console.log(`state saved`, stateFile);

  if (allNotifs.length) {
    await postSlackBatches(allNotifs, { batchSize: envInt("SLACK_BATCH", 3) });
  }

  console.log("monitor DONE");
}

main().catch((e) => {
  console.error("monitor ERROR", e);
  process.exit(1);
});
