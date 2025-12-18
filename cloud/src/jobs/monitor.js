// cloud/src/jobs/monitor.js
// Keepa Finder → Product → Slack 通知ジョブ（カード型レイアウト）

import "dotenv/config";
import {
  keepaQuery,
  keepaProduct,
  buildKeepaGraphUrl,
  keepaProductPageUrl,
} from "../services/keepa.js";
import { slack } from "../services/slack.js";

/* ================= env ================= */

const FINDER_PER_PAGE = numEnv("FINDER_PER_PAGE", 100);
const FINDER_MAX_PAGES = numEnv("FINDER_MAX_PAGES", 5);
const SLACK_BATCH = clamp(numEnv("SLACK_BATCH", 3), 1, 3);
const MAX_NOTIFY = numEnv("MAX_NOTIFY", 50);

const GRAPH_RANGE = numEnv("KEEPA_GRAPH_RANGE", 3);
const GRAPH_WIDTH = numEnv("KEEPA_GRAPH_FULL_WIDTH", 1200);
const GRAPH_HEIGHT = numEnv("KEEPA_GRAPH_FULL_HEIGHT", 600);

const DOMAIN = Number(process.env.KEEPA_DOMAIN || 5);

/* ================= profiles ================= */

const PROFILES = [
  { name: "おもちゃ", rootCategory: 13299531, limit: 30, excludeDigital: false },
  { name: "ゲーム", rootCategory: 637394, limit: 30, excludeDigital: true },
  { name: "ホビー", rootCategory: 2277721051, limit: 30, excludeDigital: false },
];

const DIGITAL_KEYWORDS = [
  "オンラインコード",
  "ダウンロード",
  "download",
  "digital",
];

/* ================= utils ================= */

function numEnv(key, def) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : def;
}
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}
function log(...a) {
  console.log(new Date().toISOString(), ...a);
}
function yen(v) {
  return v != null ? `¥${Number(v).toLocaleString("ja-JP")}` : "-";
}
function normalizeTitle(t = "") {
  return t.replace(/\s+/g, " ").trim();
}
function isDigitalTitle(t = "") {
  const l = t.toLowerCase();
  return DIGITAL_KEYWORDS.some((k) => l.includes(k));
}
function chunk(arr, size) {
  const r = [];
  for (let i = 0; i < arr.length; i += size) r.push(arr.slice(i, i + size));
  return r;
}

/* ================= data helpers ================= */

function getStatsBasics(stats = {}) {
  const c = stats.current || [];
  return {
    amazonPrice: c[0] > 0 ? c[0] : null,
    newPrice: c[1] > 0 ? c[1] : null,
    salesRank: c[3] > 0 ? c[3] : null,
  };
}

function getTotalOfferCount(stats = {}) {
  return typeof stats.totalOfferCount === "number"
    ? stats.totalOfferCount
    : null;
}

function getMainImageUrl(product = {}) {
  if (!product.imagesCSV) return null;
  const id = product.imagesCSV.split(",")[0];
  return id ? `https://m.media-amazon.com/images/I/${id}.jpg` : null;
}

function buildItemView(p) {
  const stats = p.stats || {};
  const { amazonPrice, newPrice, salesRank } = getStatsBasics(stats);

  return {
    asin: p.asin,
    title: normalizeTitle(p.title),
    price: newPrice ?? amazonPrice,
    sellers: getTotalOfferCount(stats),
    rank: salesRank,
    sold30:
      stats.salesRankDrops30 ??
      stats.salesRankDrops90 ??
      stats.salesRankDrops180 ??
      null,
    amazonUrl: `https://www.amazon.co.jp/dp/${p.asin}`,
    keepaUrl: keepaProductPageUrl(p.asin),
    imageUrl: getMainImageUrl(p),
    graphUrl: buildKeepaGraphUrl({
      asin: p.asin,
      rangeDays: GRAPH_RANGE,
      width: GRAPH_WIDTH,
      height: GRAPH_HEIGHT,
    }),
  };
}

/* ================= finder ================= */

async function fetchAsins(profile) {
  const out = [];
  for (let page = 0; page < FINDER_MAX_PAGES; page++) {
    const res = await keepaQuery({
      domainId: DOMAIN,
      rootCategory: profile.rootCategory,
      page,
      perPage: FINDER_PER_PAGE,
      sort: [["current_SALES", "asc"]],
      productType: [0, 1, 2],
    });
    const list = res?.asinList || [];
    if (!list.length) break;
    list.forEach((a) => !out.includes(a) && out.push(a));
    if (list.length < FINDER_PER_PAGE) break;
  }
  return out.slice(0, profile.limit * 10);
}

/* ================= slack layout ================= */

function buildBlocks(profileName, items) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: profileName },
    },
  ];

  for (const it of items) {
    /* タイトル + 画像 */
    const top = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${it.title}*\nASIN: \`${it.asin}\``,
      },
    };
    if (it.imageUrl) {
      top.accessory = {
        type: "image",
        image_url: it.imageUrl,
        alt_text: it.title.slice(0, 80),
      };
    }
    blocks.push(top);

    /* 🔘 Amazon / Keepa ボタン（価格より上） */
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Amazon" },
          url: it.amazonUrl,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Keepa" },
          url: it.keepaUrl,
        },
      ],
    });

    /* 数値情報（日本語） */
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*価格*\n${yen(it.price)}円` },
        { type: "mrkdwn", text: `*出品者*\n${it.sellers ?? "-"}人` },
        { type: "mrkdwn", text: `*ランキング*\n${it.rank ?? "-"}位` },
        { type: "mrkdwn", text: `*30日販売数*\n${it.sold30 ?? "-"}個` },
      ],
    });

    /* Keepa グラフ画像（表示） */
    if (it.graphUrl) {
      blocks.push({
        type: "image",
        image_url: it.graphUrl,
        alt_text: `Keepa graph ${it.asin}`,
      });
    }

    blocks.push({ type: "divider" });
  }

  return blocks;
}

/* ================= main ================= */

async function processProfile(profile, remaining) {
  log(`profile START ${profile.name}`);

  const asins = await fetchAsins(profile);
  if (!asins.length) return 0;

  const picked = [];
  for (const ch of chunk(asins, 20)) {
    if (picked.length >= remaining) break;

    const res = await keepaProduct(ch, { statsDays: 90 });
    for (const p of res?.products || []) {
      if (!p?.asin) continue;
      if (profile.excludeDigital && isDigitalTitle(p.title)) continue;

      const stats = p.stats || {};
      const basics = getStatsBasics(stats);
      if (basics.amazonPrice) continue;

      const sellers = getTotalOfferCount(stats);
      if (sellers == null || sellers < 3) continue;

      picked.push(buildItemView(p));
      if (picked.length >= profile.limit) break;
    }
  }

  if (!picked.length) {
    log(`profile DONE ${profile.name} notified=0`);
    return 0;
  }

  for (const g of chunk(picked, SLACK_BATCH)) {
    await slack({
      text: `${profile.name} 新着 ${g.length}件`,
      blocks: buildBlocks(profile.name, g),
    });
  }

  log(`profile DONE ${profile.name} notified=${picked.length}`);
  return picked.length;
}

async function main() {
  log("monitor START");
  let remain = MAX_NOTIFY;

  for (const p of PROFILES) {
    if (remain <= 0) break;
    remain -= await processProfile(p, remain);
  }

  log("monitor DONE");
}

main().catch((e) => {
  console.error("monitor FATAL", e);
  process.exit(1);
});
