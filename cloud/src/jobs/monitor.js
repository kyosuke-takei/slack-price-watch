// cloud/src/jobs/monitor.js
// Keepa Finder → Product → Slack 通知ジョブ
// カテゴリ: おもちゃ / ゲーム / ホビー
// ★ ONLY_PROFILE で 1ジャンルだけ実行できるように拡張
// ★ PROFILE_LIMIT で 1回の通知件数(=各プロファイルlimit)を上書きできるように拡張

import "dotenv/config";
import {
  keepaQuery,
  keepaProduct,
  buildKeepaGraphUrl,
  keepaProductPageUrl,
} from "../services/keepa.js";
import { slack } from "../services/slack.js";

// ===== env =====
const FINDER_PER_PAGE = numEnv("FINDER_PER_PAGE", 100);
const FINDER_MAX_PAGES = numEnv("FINDER_MAX_PAGES", 5);

// SLACK_BATCH は 1〜3 に強制キャップ（でかいバッチは Slack が嫌がる）
const SLACK_BATCH = clamp(numEnv("SLACK_BATCH", 3), 1, 3);
const MAX_NOTIFY = numEnv("MAX_NOTIFY", 50);

// ★ 1プロファイルの通知上限を env で上書き（ローテ運用は 30 推奨）
const PROFILE_LIMIT = numEnv("PROFILE_LIMIT", 10);

// ★ どれか1ジャンルだけ動かす（例: toys / games / hobby）
const ONLY_PROFILE_RAW = (process.env.ONLY_PROFILE || "").trim().toLowerCase();

const GRAPH_IMAGE =
  (process.env.KEEPA_GRAPH_IMAGE || "on").toLowerCase() === "on";
const GRAPH_RANGE = numEnv("KEEPA_GRAPH_RANGE", 3);
const GRAPH_THUMB_WIDTH = numEnv("KEEPA_GRAPH_THUMB_WIDTH", 720);
const GRAPH_THUMB_HEIGHT = numEnv("KEEPA_GRAPH_THUMB_HEIGHT", 360);
const GRAPH_FULL_WIDTH = numEnv("KEEPA_GRAPH_FULL_WIDTH", 1600);
const GRAPH_FULL_HEIGHT = numEnv("KEEPA_GRAPH_FULL_HEIGHT", 800);

const DOMAIN = Number(process.env.KEEPA_DOMAIN || 5); // 5 = JP

// ===== プロファイル定義 =====
// ★ key を追加（ローテ・ONLY_PROFILE用）
const PROFILES = [
  {
    key: "toys",
    name: "おもちゃ",
    rootCategory: 13299531,
    limit: PROFILE_LIMIT,
    excludeDigital: false,
  },
  {
    key: "games",
    name: "ゲーム",
    rootCategory: 637394,
    limit: PROFILE_LIMIT,
    excludeDigital: true,
  },
  {
    key: "hobby",
    name: "ホビー",
    rootCategory: 2277721051,
    limit: PROFILE_LIMIT,
    excludeDigital: false,
  },
];

// DL版っぽいタイトルを弾くためのキーワード
const DIGITAL_KEYWORDS = [
  "オンラインコード",
  "オンライン コード",
  "ダウンロード",
  "download",
  "digital code",
  "ダウンロード版",
];

// ===== util =====
function numEnv(key, def) {
  const v = process.env[key];
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isDigitalTitle(title = "") {
  const lower = title.toLowerCase();
  return DIGITAL_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function yen(v) {
  if (v == null) return "-";
  return `¥${Number(v).toLocaleString("ja-JP")}`;
}

// タイトルを Slack 向けに安全化（改行・タブ等を潰す）
function normalizeTitle(rawTitle) {
  return (rawTitle || "(no title)").replace(/\s+/g, " ").trim();
}

// Keepa stats.current から基本情報を抜く
function getStatsBasics(stats = {}) {
  const current = Array.isArray(stats.current) ? stats.current : [];
  const amazonRaw = current[0];
  const newRaw = current[1];
  const rankRaw = current[3];

  const amazonPrice =
    typeof amazonRaw === "number" && amazonRaw > 0 ? amazonRaw : null;
  const newPrice =
    typeof newRaw === "number" && newRaw > 0 ? newRaw : null;
  const salesRank =
    typeof rankRaw === "number" && rankRaw > 0 ? rankRaw : null;

  return { amazonPrice, newPrice, salesRank };
}

// ★ 過去の総出品者数（totalOfferCount）を取得
function getTotalOfferCount(stats = {}) {
  const raw = stats.totalOfferCount;
  if (typeof raw === "number" && raw >= 0) return raw;
  return null;
}

// ★ 商品画像URLを取得（imagesCSV → 先頭1枚）
function getMainImageUrl(product = {}) {
  const csv = product.imagesCSV;
  if (!csv || typeof csv !== "string") return null;
  const firstId = csv.split(",")[0];
  if (!firstId) return null;

  // m.media-amazon.com の標準画像
  return `https://m.media-amazon.com/images/I/${firstId}.jpg`;
}

// Slack 用に整形した 1 アイテム分のビュー
function buildItemView(product) {
  const { asin } = product;
  const rawTitle = product.title || "";
  const safeTitle = normalizeTitle(rawTitle);

  const stats = product.stats || {};
  const { amazonPrice, newPrice, salesRank } = getStatsBasics(stats);
  const monthlySold =
    stats.salesRankDrops30 ??
    stats.salesRankDrops90 ??
    stats.salesRankDrops180 ??
    null;

  const totalOfferCount = getTotalOfferCount(stats);
  const offerCount = totalOfferCount; // 表示用も totalOfferCount を採用

  const priceNow = newPrice ?? amazonPrice ?? null;

  const amazonUrl = `https://www.amazon.co.jp/dp/${asin}`;
  const keepaUrl = keepaProductPageUrl(asin);
  const imageUrl = getMainImageUrl(product);

  const thumbGraphUrl = GRAPH_IMAGE
    ? buildKeepaGraphUrl({
        asin,
        rangeDays: GRAPH_RANGE,
        width: GRAPH_THUMB_WIDTH,
        height: GRAPH_THUMB_HEIGHT,
      })
    : null;

  const fullGraphUrl = GRAPH_IMAGE
    ? buildKeepaGraphUrl({
        asin,
        rangeDays: GRAPH_RANGE,
        width: GRAPH_FULL_WIDTH,
        height: GRAPH_FULL_HEIGHT,
      })
    : null;

  return {
    asin,
    title: safeTitle,
    salesRank,
    monthlySold,
    offerCount,
    priceNow,
    amazonUrl,
    keepaUrl,
    imageUrl,
    thumbGraphUrl,
    fullGraphUrl,
  };
}

// ===== Finder: asinList を取得 =====
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

    const res = await keepaQuery(payload);
    const list = Array.isArray(res?.asinList) ? res.asinList : [];

    if (!list.length) break;

    for (const asin of list) {
      if (!asins.includes(asin)) {
        asins.push(asin);
      }
    }

    if (list.length < FINDER_PER_PAGE) break;

    page += 1;
  }

  // 後段フィルタでガンガン減るので、limitの10倍まで候補を残す
  const maxCandidates = profile.limit * 10;
  return asins.slice(0, maxCandidates);
}

// ===== Slack Blocks =====
function buildBlocksForProfile(profileName, items) {
  const header = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${profileName}*`,
    },
  };

  const divider = { type: "divider" };
  const blocks = [header, divider];

  for (const item of items) {
    const lines = [];

    lines.push(item.title || "(no title)");
    lines.push("");

    lines.push("【新品価格】");
    lines.push(`新品価格：${item.priceNow != null ? yen(item.priceNow) : "-"}`);
    lines.push("");

    lines.push("【出品者数】");
    lines.push(`出品者数：${item.offerCount != null ? item.offerCount : "-"}名`);
    lines.push("");

    lines.push("【ランキング】");
    lines.push(`ランキング順位：${item.salesRank ?? "-"}位`);
    lines.push(
      `直近30日販売数：${item.monthlySold != null ? item.monthlySold : "-"}個`
    );
    lines.push("");

    lines.push("【Amazon商品URL】");
    lines.push(item.amazonUrl);
    lines.push("");

    lines.push("【Keepa詳細URL】");
    lines.push(item.keepaUrl);

    const section = {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    };

    if (item.imageUrl) {
      const altText = (item.title || item.asin || "").replace(/\s+/g, " ").slice(0, 80);
      section.accessory = {
        type: "image",
        image_url: item.imageUrl,
        alt_text: altText || "product image",
      };
    }

    blocks.push(section);

    if (GRAPH_IMAGE && item.thumbGraphUrl) {
      const altTextGraph = (item.title || item.asin || "").replace(/\s+/g, " ").slice(0, 80);
      blocks.push({
        type: "image",
        image_url: item.thumbGraphUrl,
        alt_text: altTextGraph || item.asin || "Keepa graph",
      });
    }

    blocks.push(divider);
  }

  return blocks;
}

// グループ送信が失敗したら、そのグループを1件ずつに分解して再送
async function sendProfileToSlack(profileName, items) {
  if (!items.length) return;

  const groupChunks = chunk(items, SLACK_BATCH);

  for (const group of groupChunks) {
    const firstTitle = normalizeTitle(group[0].title);
    const blocks = buildBlocksForProfile(profileName, group);
    const textFallback = `${profileName}: ${firstTitle.slice(0, 60)} ほか${group.length}件`;

    try {
      await slack({ text: textFallback, blocks });
    } catch (err) {
      log(`Slack group post failed (${profileName}, size=${group.length}):`, err.message || err);

      // フォールバック：1件ずつ送信
      for (const item of group) {
        const singleBlocks = buildBlocksForProfile(profileName, [item]);
        const singleTitle = normalizeTitle(item.title);
        const singleText = `${profileName}: ${singleTitle.slice(0, 60)}`;

        try {
          await slack({ text: singleText, blocks: singleBlocks });
        } catch (err2) {
          log(`Slack single post failed (${profileName}, asin=${item.asin}):`, err2.message || err2);
        }
      }
    }
  }
}

// ===== メイン処理 =====
async function processProfile(profile, remainingNotify) {
  log(`profile START ${profile.name}`);

  const asins = await fetchAsinsForProfile(profile);

  if (!asins.length) {
    log(`No items for ${profile.name}`);
    return 0;
  }

  const asinChunks = chunk(asins, 20);
  const picked = [];

  const cap = Math.min(profile.limit, remainingNotify);

  for (const ch of asinChunks) {
    if (picked.length >= cap) break;

    let res;
    try {
      res = await keepaProduct(ch, { statsDays: 90 });
    } catch (err) {
      log("Product error:", err.message || err);
      continue;
    }

    const products = Array.isArray(res?.products) ? res.products : [];

    for (const p of products) {
      if (!p || !p.asin) continue;

      // ゲーム: DL版除外
      if (profile.excludeDigital && isDigitalTitle(p.title)) continue;

      const stats = p.stats || {};
      const basics = getStatsBasics(stats);

      // Amazon 在庫があるもの（amazonPrice>0）は除外
      if (basics.amazonPrice && basics.amazonPrice > 0) continue;

      // 過去の総出品者数が 3 未満の商品は除外
      const totalOfferCount = getTotalOfferCount(stats);
      if (totalOfferCount == null || totalOfferCount < 3) continue;

      const view = buildItemView(p);
      picked.push(view);

      if (picked.length >= cap) break;
    }
  }

  if (!picked.length) {
    log(`No items for ${profile.name} after filters`);
    return 0;
  }

  await sendProfileToSlack(profile.name, picked);

  log(`profile DONE ${profile.name} notified=${picked.length}`);
  return picked.length;
}

function selectProfiles() {
  if (!ONLY_PROFILE_RAW) return PROFILES;

  // toys/games/hobby のkeyで指定
  const one = PROFILES.filter((p) => p.key === ONLY_PROFILE_RAW);
  if (one.length) return one;

  // 「おもちゃ」「ゲーム」「ホビー」指定でも動くように保険
  const jp = PROFILES.filter((p) => p.name === ONLY_PROFILE_RAW);
  if (jp.length) return jp;

  log(`WARN: Unknown ONLY_PROFILE="${ONLY_PROFILE_RAW}". Run all profiles.`);
  return PROFILES;
}

async function main() {
  log("monitor START", ONLY_PROFILE_RAW ? `(ONLY_PROFILE=${ONLY_PROFILE_RAW})` : "");

  let remaining = MAX_NOTIFY;

  const targets = selectProfiles();
  for (const profile of targets) {
    if (remaining <= 0) break;
    const used = await processProfile(profile, remaining);
    remaining -= used;
  }

  log("monitor DONE");
}

main().catch((err) => {
  console.error("monitor FATAL", err);
  process.exitCode = 1;
});
