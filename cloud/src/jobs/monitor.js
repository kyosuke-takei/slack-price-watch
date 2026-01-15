// cloud/src/jobs/monitor.js
// Monitor ALL categories -> notify ONLY on changes
// Change detection:
//  - sellers decreased
//  - price increased
//  - rank improved (smaller is better)
// Slack layout: 日本語 / 商品画像あり / Keepaグラフなし / ボタンは下

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { keepaQuery, keepaProduct, keepaProductPageUrl } from "../services/keepa.js";
import { slack } from "../services/slack.js";

/* =========================
 * env
 * ========================= */
const FINDER_PER_PAGE = numEnv("FINDER_PER_PAGE", 50);
const FINDER_MAX_PAGES = numEnv("FINDER_MAX_PAGES", 2);
const STATS_DAYS = numEnv("STATS_DAYS", 90);

const SLACK_BATCH = clamp(numEnv("SLACK_BATCH", 1), 1, 3);
const MAX_NOTIFY = numEnv("MAX_NOTIFY", 30);

const DOMAIN = Number(process.env.KEEPA_DOMAIN || 5); // 5=JP

// 例: ONLY_PROFILE=hobby | toys | games (なければ全カテゴリ)
const ONLY_PROFILE = (process.env.ONLY_PROFILE || "").trim().toLowerCase();

// state file
const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

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
 * utils
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
function log(...args) {
  console.log(new Date().toISOString(), ...args);
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
  return `${Number(v).toLocaleString("ja-JP")}`;
}

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

function readState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STATE_FILE)) return {};
    const txt = fs.readFileSync(STATE_FILE, "utf-8");
    const json = JSON.parse(txt);
    if (json && typeof json === "object") return json;
  } catch (e) {
    log("state read error (ignored):", e?.message || e);
  }
  return {};
}

function writeState(state) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    log("state write error:", e?.message || e);
  }
}

// 429などは待って自動リトライ
async function withRetry(fn, { label = "call", maxRetries = 5 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;

      const msg = String(err?.message || err);
      const refillIn = extractRefillInMs(msg);

      if (refillIn != null) {
        const waitMs = Math.min(refillIn + 250, 60_000); // 最大60秒にキャップ
        log(`${label}: 429 detected -> wait ${waitMs}ms then retry (attempt ${attempt}/${maxRetries})`);
        if (attempt > maxRetries) throw err;
        await sleep(waitMs);
        continue;
      }

      // その他の一時エラーは指数バックオフ
      const backoff = Math.min(500 * Math.pow(2, attempt - 1), 10_000);
      log(`${label}: error -> ${msg} (attempt ${attempt}/${maxRetries}) backoff=${backoff}ms`);
      if (attempt > maxRetries) throw err;
      await sleep(backoff);
    }
  }
}

function extractRefillInMs(message) {
  // 例: Keepa 429 Too Many Requests - {"refillIn":11944,...}
  try {
    const m = message.match(/"refillIn"\s*:\s*(\d+)/);
    if (!m) return null;
    const ms = Number(m[1]);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  } catch {
    return null;
  }
}

/* =========================
 * Finder: get asin candidates
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
 * Change detection
 * ========================= */
function buildCurrentSnapshot(product) {
  const stats = product.stats || {};
  const { amazonPrice, newPrice, salesRank } = getStatsBasics(stats);
  const monthlySold = stats.salesRankDrops30 ?? stats.salesRankDrops90 ?? stats.salesRankDrops180 ?? null;
  const offerCount = getTotalOfferCount(stats);

  const priceNow = newPrice ?? amazonPrice ?? null;

  return {
    price: priceNow,
    sellers: offerCount,
    rank: salesRank,
    sold30: monthlySold,
  };
}

function detectChange(prevSnap, currSnap) {
  // 조건:
  //  - sellers decreased
  //  - price increased
  //  - rank improved (smaller is better)
  if (!prevSnap) return { changed: false, reasons: [] };

  const reasons = [];

  // sellers: 감소 감지 (null이면 비교불가)
  if (isNum(prevSnap.sellers) && isNum(currSnap.sellers) && currSnap.sellers < prevSnap.sellers) {
    reasons.push(`出品者 減少 ${prevSnap.sellers}→${currSnap.sellers}`);
  }

  // price: 上昇 감지
  if (isNum(prevSnap.price) && isNum(currSnap.price) && currSnap.price > prevSnap.price) {
    reasons.push(`価格 上昇 ${yen(prevSnap.price)}→${yen(currSnap.price)}`);
  }

  // rank: 改善 (数値が小さくなる)
  if (isNum(prevSnap.rank) && isNum(currSnap.rank) && currSnap.rank < prevSnap.rank) {
    reasons.push(`ランキング 上昇(改善) ${prevSnap.rank}→${currSnap.rank}`);
  }

  return { changed: reasons.length > 0, reasons };
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/* =========================
 * Slack blocks
 * ========================= */
function buildBlocks(profileName, item) {
  // item: { title, asin, amazonUrl, keepaUrl, imageUrl, snap, reasons[] }
  const blocks = [];

  // タイトル + 画像（右）
  const titleSection = {
    type: "section",
    text: { type: "mrkdwn", text: `*${item.title}*` },
  };

  if (item.imageUrl) {
    titleSection.accessory = {
      type: "image",
      image_url: item.imageUrl,
      alt_text: (item.title || item.asin || "").slice(0, 80),
    };
  }
  blocks.push(titleSection);

  // 数値情報（日本語）
  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*価格*\n${item.snap.price != null ? yen(item.snap.price) : "-"}` },
      { type: "mrkdwn", text: `*出品者*\n${item.snap.sellers ?? "-"}人` },
      { type: "mrkdwn", text: `*ランキング*\n${item.snap.rank ?? "-"}位` },
      { type: "mrkdwn", text: `*30日販売数*\n${item.snap.sold30 ?? "-"}個` },
    ],
  });

  // 変化理由
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `*検知:* ${item.reasons.join(" / ")}`,
      },
    ],
  });

  // ボタン（下）
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Amazon" },
        url: item.amazonUrl,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Keepa" },
        url: item.keepaUrl,
      },
    ],
  });

  // フッタ
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `カテゴリ: *${profileName}*  / ASIN: \`${item.asin}\`` }],
  });

  blocks.push({ type: "divider" });

  return blocks;
}

async function postToSlack(profileName, items) {
  if (!items.length) return 0;

  // Slackはデカいblocks嫌うので「1通知=1商品」を基本にする
  // ただし SLACK_BATCH > 1 の場合はまとめて投げる（失敗したら分割フォールバック）
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
      log(`Slack group post failed (${profileName}, size=${group.length}) -> fallback single`, e?.message || e);

      // 1件ずつ
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
 * Main per profile
 * ========================= */
async function processProfile(profile, state, remainingNotify) {
  log(`profile START ${profile.name}`);

  const asins = await fetchAsinsForProfile(profile);
  if (!asins.length) {
    log(`profile DONE ${profile.name} (no asins)`);
    return { notified: 0, nextState: state };
  }

  // Product APIはまとめて20ずつ
  const asinChunks = chunk(asins, 20);

  const notifyItems = [];
  const nextState = { ...state }; // shallow copy

  for (const ch of asinChunks) {
    if (notifyItems.length >= remainingNotify) break;

    let res;
    try {
      res = await withRetry(() => keepaProduct(ch, { statsDays: STATS_DAYS }), {
        label: `keepaProduct:${profile.key}`,
        maxRetries: 8,
      });
    } catch (e) {
      // ここで落とさない（カテゴリ継続）
      log(`keepaProduct fatal for ${profile.name} (continue)`, e?.message || e);
      continue;
    }

    const products = Array.isArray(res?.products) ? res.products : [];

    for (const p of products) {
      if (!p?.asin) continue;

      // ゲーム: DL版除外
      if (profile.excludeDigital && isDigitalTitle(p.title)) continue;

      const snap = buildCurrentSnapshot(p);

      // Amazon在庫があるのは除外（amazonPrice>0 の場合、priceに入る可能性があるので別で判定）
      const basics = getStatsBasics(p.stats || {});
      if (basics.amazonPrice && basics.amazonPrice > 0) continue;

      // 出品者が3未満は除外（prev比較対象にもならないのでノイズ防止）
      if (snap.sellers == null || snap.sellers < 3) {
        // ただ state は更新しておく（次回の基準）
        nextState[p.asin] = { ...(nextState[p.asin] || {}), ...snap };
        continue;
      }

      const prev = state[p.asin];
      const { changed, reasons } = detectChange(prev, snap);

      // state更新（常に最新にする）
      nextState[p.asin] = { ...(nextState[p.asin] || {}), ...snap };

      if (!changed) continue;

      const title = normalizeTitle(p.title);
      const amazonUrl = `https://www.amazon.co.jp/dp/${p.asin}`;
      const keepaUrl = keepaProductPageUrl(p.asin);
      const imageUrl = getMainImageUrl(p);

      notifyItems.push({
        asin: p.asin,
        title,
        amazonUrl,
        keepaUrl,
        imageUrl,
        snap,
        reasons,
      });

      if (notifyItems.length >= remainingNotify) break;
    }
  }

  // 通知
  let sent = 0;
  if (notifyItems.length) {
    sent = await postToSlack(profile.name, notifyItems);
  }

  log(`profile DONE ${profile.name} notified=${sent}`);

  return { notified: sent, nextState };
}

/* =========================
 * Main
 * ========================= */
async function main() {
  log(`monitor START (ONLY_PROFILE=${ONLY_PROFILE || "all"})`);

  const state = readState();

  // 対象プロファイル決定
  let targets = PROFILES;
  if (ONLY_PROFILE) {
    targets = PROFILES.filter((p) => p.key === ONLY_PROFILE);
    if (!targets.length) {
      log(`Unknown ONLY_PROFILE=${ONLY_PROFILE} -> fallback all`);
      targets = PROFILES;
    }
  }

  let remaining = MAX_NOTIFY;
  let nextState = state;

  for (const profile of targets) {
    if (remaining <= 0) break;

    const result = await processProfile(profile, nextState, remaining);
    remaining -= result.notified;
    nextState = result.nextState;
  }

  writeState(nextState);

  log("monitor DONE");
}

main().catch((err) => {
  console.error("monitor FATAL", err?.message || err);
  process.exitCode = 1;
});
