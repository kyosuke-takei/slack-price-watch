// cloud/src/jobs/monitor.js
// Slack Price Monitor (cloud) - state diff + cache persistence
// - state.json is stored in GitHub Actions cache (not committed)
// - Notify only when diff exceeds thresholds (or first time -> NEW)
// - Skip < MIN_PRICE_YEN at fetch stage (not stored)
// - Cooldown to avoid spam
// - 429 Too Many Requests: wait refillIn then retry
// - Product image: yes
// - Buttons (Amazon/Keepa): bottom

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
const MAX_NOTIFY = numEnv("MAX_NOTIFY", 30);

const DOMAIN = Number(process.env.KEEPA_DOMAIN || 5); // 5=JP
const ONLY_PROFILE = (process.env.ONLY_PROFILE || "").trim().toLowerCase();

// diff tuning
const MIN_PRICE_YEN = numEnv("MIN_PRICE_YEN", 2000);
const PRICE_DELTA_YEN = numEnv("PRICE_DELTA_YEN", 200);
const RANK_DELTA_ABS = numEnv("RANK_DELTA_ABS", 5000);
const SELLERS_DELTA_ABS = numEnv("SELLERS_DELTA_ABS", 1);
const SOLD30_DELTA_ABS = numEnv("SOLD30_DELTA_ABS", 5);
const NOTIFY_COOLDOWN_HOURS = numEnv("NOTIFY_COOLDOWN_HOURS", 6);

// state file path (repo root 기준)
const STATE_FILE = (process.env.STATE_FILE || "cloud/data/state.json").trim();
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
  // Actions log 見やすさ優先（ISOより短い）
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
function abs(n) {
  return typeof n === "number" ? Math.abs(n) : null;
}
function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
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
 * =========================
 * {
 *   version: 1,
 *   updatedAt: number(ms),
 *   asins: {
 *     [asin]: {
 *       asin, title,
 *       price, rank, sellers, sold30,
 *       firstSeenAt, lastSeenAt,
 *       lastNotifiedAt
 *     }
 *   }
 * }
 */
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
  const removed = pruneState(state);
  writeJsonAtomic(STATE_FILE, state);
  log("state saved", { file: STATE_FILE, asinCount: Object.keys(state.asins).length, pruned: removed });
}

/* =========================
 * Keepa helpers
 * ========================= */
// Keepa stats.current: [amazon, new, used, salesRank, ...]
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
  // "refillIn":11944
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
 * diff logic
 * ========================= */
function buildDiff(prev, curr) {
  // prev なし = NEW
  if (!prev) return { changed: true, label: "NEW", parts: ["NEW"] };

  const parts = [];
  let changed = false;

  // price
  if (curr.price != null && prev.price != null) {
    const d = curr.price - prev.price;
    if (abs(d) != null && abs(d) >= PRICE_DELTA_YEN) {
      changed = true;
      parts.push(`価格 ${d > 0 ? "+" : ""}${d.toLocaleString("ja-JP")}円`);
    }
  } else if (curr.price != null && prev.price == null) {
    changed = true;
    parts.push(`価格 - → ${yen(curr.price)}`);
  } else if (curr.price == null && prev.price != null) {
    changed = true;
    parts.push(`価格 ${yen(prev.price)} → -`);
  }

  // rank (小さいほど良い。変化は絶対値で判定、表示は符号付き)
  if (curr.rank != null && prev.rank != null) {
    const d = curr.rank - prev.rank;
    if (abs(d) != null && abs(d) >= RANK_DELTA_ABS) {
      changed = true;
      parts.push(`ランク ${d > 0 ? "+" : ""}${d.toLocaleString("ja-JP")}`);
    }
  }

  // sellers
  if (curr.sellers != null && prev.sellers != null) {
    const d = curr.sellers - prev.sellers;
    if (abs(d) != null && abs(d) >= SELLERS_DELTA_ABS) {
      changed = true;
      parts.push(`出品者 ${d > 0 ? "+" : ""}${d}`);
    }
  }

  // sold30
  if (curr.sold30 != null && prev.sold30 != null) {
    const d = curr.sold30 - prev.sold30;
    if (abs(d) != null && abs(d) >= SOLD30_DELTA_ABS) {
      changed = true;
      parts.push(`30日販売数 ${d > 0 ? "+" : ""}${d}`);
    }
  }

  if (!changed) return { changed: false, label: "NO_DIFF", parts: [] };
  return { changed: true, label: parts.join(" / "), parts };
}

function inCooldown(prev) {
  if (!prev?.lastNotifiedAt) return false;
  const ms = NOTIFY_COOLDOWN_HOURS * 60 * 60 * 1000;
  return ts() - prev.lastNotifiedAt < ms;
}

/* =========================
 * Slack layout
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

  // diff 表示（ここが肝）
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
async function processProfile(profile, remainingNotify, state) {
  log(`profile START ${profile.name}`);

  const asins = await fetchAsinsForProfile(profile);
  if (!asins.length) {
    log(`profile DONE ${profile.name} (no asins)`);
    return { used: 0, picked: 0, scanned: 0, cooldownSkip: 0, noDiff: 0 };
  }

  const asinChunks = chunk(asins, 20);
  const pickedToNotify = [];

  let scanned = 0;
  let picked = 0;
  let cooldownSkip = 0;
  let noDiff = 0;

  for (const ch of asinChunks) {
    if (pickedToNotify.length >= remainingNotify) break;

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

      // Amazon在庫があるものは除外
      if (amazonPrice && amazonPrice > 0) continue;

      const sellers = getTotalOfferCount(stats);
      if (sellers == null || sellers < 3) continue;

      const monthlySold = stats.salesRankDrops30 ?? stats.salesRankDrops90 ?? stats.salesRankDrops180 ?? null;
      const price = newPrice ?? amazonPrice ?? null;

      // ★ここが要望：取得時点で <2000 を弾く（保存もしない）
      if (price == null || price < MIN_PRICE_YEN) continue;

      const asin = p.asin;
      const now = ts();
      const prev = state.asins[asin];

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

      // state は「通知する/しない」関係なく更新（次回比較のため）
      const diff = buildDiff(prev, curr);

      // state 更新
      const nextEntry = {
        asin,
        title: curr.title,
        price: curr.price,
        rank: curr.rank,
        sellers: curr.sellers,
        sold30: curr.sold30,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
        lastNotifiedAt: prev?.lastNotifiedAt ?? 0,
      };
      state.asins[asin] = nextEntry;

      // 差分が無いなら通知しない
      if (!diff.changed) {
        noDiff += 1;
        continue;
      }

      // クールダウン中なら通知しない（でも state は更新済み）
      if (inCooldown(prev)) {
        cooldownSkip += 1;
        continue;
      }

      // 通知候補
      picked += 1;
      pickedToNotify.push({ ...curr, diffLabel: diff.label });

      if (pickedToNotify.length >= PROFILE_LIMIT || pickedToNotify.length >= remainingNotify) break;
    }
  }

  if (!pickedToNotify.length) {
    log(`profile DONE ${profile.name} notified=0 picked=${picked} scanned=${scanned} cooldownSkip=${cooldownSkip} noDiff=${noDiff}`);
    return { used: 0, picked, scanned, cooldownSkip, noDiff };
  }

  const sent = await postToSlack(profile.name, pickedToNotify);

  // 通知したASINは lastNotifiedAt 更新
  const now2 = ts();
  for (const it of pickedToNotify.slice(0, sent)) {
    if (state.asins[it.asin]) state.asins[it.asin].lastNotifiedAt = now2;
  }

  log(`profile DONE ${profile.name} notified=${sent} picked=${picked} scanned=${scanned} cooldownSkip=${cooldownSkip} noDiff=${noDiff}`);
  return { used: sent, picked, scanned, cooldownSkip, noDiff };
}

/* =========================
 * main
 * ========================= */
async function main() {
  log(`monitor START (ONLY_PROFILE=${ONLY_PROFILE || "all"})`);

  // stateを必ず作る（空でもファイルが生成されるように）
  const state = loadState();
  if (!fs.existsSync(STATE_FILE)) {
    // loadState が fallback を返すだけでファイルは作らないので、ここで作る
    writeJsonAtomic(STATE_FILE, state);
    log("state file created", { file: STATE_FILE });
  }

  let targets = PROFILES;
  if (ONLY_PROFILE) {
    const filtered = PROFILES.filter((p) => p.key === ONLY_PROFILE);
    if (filtered.length) targets = filtered;
    else log(`Unknown ONLY_PROFILE=${ONLY_PROFILE} -> fallback all`);
  }

  let remaining = MAX_NOTIFY;
  let totalNotified = 0;

  for (const profile of targets) {
    if (remaining <= 0) break;
    const r = await processProfile(profile, remaining, state);
    remaining -= r.used;
    totalNotified += r.used;
  }

  saveState(state);

  log("monitor DONE", { notified: totalNotified });
}

main().catch((err) => {
  console.error("monitor FATAL", err?.message || err);
  process.exitCode = 1;
});
