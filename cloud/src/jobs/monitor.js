// cloud/src/jobs/monitor.js
// Keepa Finder → Product → Slack 通知ジョブ
// 独自カードUI + Keepaグラフ画像「表示」版

import "dotenv/config";
import {
  keepaQuery,
  keepaProduct,
  buildKeepaGraphUrl,
  keepaProductPageUrl,
} from "../services/keepa.js";
import { slack } from "../services/slack.js";

/* =========================
   env / config
========================= */
const FINDER_PER_PAGE = numEnv("FINDER_PER_PAGE", 100);
const FINDER_MAX_PAGES = numEnv("FINDER_MAX_PAGES", 5);
const SLACK_BATCH = clamp(numEnv("SLACK_BATCH", 3), 1, 3);
const MAX_NOTIFY = numEnv("MAX_NOTIFY", 50);

const GRAPH_IMAGE =
  (process.env.KEEPA_GRAPH_IMAGE || "on").toLowerCase() === "on";
const GRAPH_RANGE = numEnv("KEEPA_GRAPH_RANGE", 3);
const GRAPH_WIDTH = numEnv("KEEPA_GRAPH_FULL_WIDTH", 1200);
const GRAPH_HEIGHT = numEnv("KEEPA_GRAPH_FULL_HEIGHT", 600);

const DOMAIN = Number(process.env.KEEPA_DOMAIN || 5); // JP
const ONLY_PROFILE = process.env.ONLY_PROFILE || null;
const PROFILE_LIMIT = numEnv("PROFILE_LIMIT", 10);

/* =========================
   profiles
========================= */
const PROFILES = [
  { key: "toys", name: "おもちゃ", rootCategory: 13299531, excludeDigital: false },
  { key: "games", name: "ゲーム", rootCategory: 637394, excludeDigital: true },
  { key: "hobby", name: "ホビー", rootCategory: 2277721051, excludeDigital: false },
];

/* =========================
   util
========================= */
function numEnv(key, def) {
  const v = process.env[key];
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}
function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}
function log(...a) {
  console.log(new Date().toISOString(), ...a);
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function yen(v) {
  return v == null ? "-" : `¥${Number(v).toLocaleString("ja-JP")}`;
}
function esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* =========================
   filters
========================= */
const DIGITAL_KEYWORDS = ["ダウンロード", "download", "digital", "dl版"];
function isDigitalTitle(t = "") {
  const l = t.toLowerCase();
  return DIGITAL_KEYWORDS.some((k) => l.includes(k));
}

/* =========================
   stats helpers
========================= */
function getStatsBasics(stats = {}) {
  const c = Array.isArray(stats.current) ? stats.current : [];
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
function getMainImageUrl(p = {}) {
  if (!p.imagesCSV) return null;
  const id = p.imagesCSV.split(",")[0];
  return id ? `https://m.media-amazon.com/images/I/${id}.jpg` : null;
}

/* =========================
   item view
========================= */
function buildItemView(p) {
  const stats = p.stats || {};
  const { amazonPrice, newPrice, salesRank } = getStatsBasics(stats);

  return {
    asin: p.asin,
    title: esc(p.title || "(no title)"),
    priceNow: newPrice ?? amazonPrice ?? null,
    salesRank,
    monthlySold: stats.salesRankDrops30 ?? stats.salesRankDrops90 ?? null,
    offerCount: getTotalOfferCount(stats),
    amazonUrl: `https://www.amazon.co.jp/dp/${p.asin}`,
    keepaUrl: keepaProductPageUrl(p.asin),
    imageUrl: getMainImageUrl(p),
    graphImageUrl: GRAPH_IMAGE
      ? buildKeepaGraphUrl({
          asin: p.asin,
          rangeDays: GRAPH_RANGE,
          width: GRAPH_WIDTH,
          height: GRAPH_HEIGHT,
        })
      : null,
  };
}

/* =========================
   Slack blocks（独自UI）
========================= */
function buildBlocks(profileName, items) {
  const blocks = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `📊 Price Monitor｜${profileName}` },
  });

  blocks.push({ type: "divider" });

  for (const it of items) {
    // 商品タイトル + 画像
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

    // 数値情報（日本語表記）
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*価格*\n${yen(it.priceNow)}` },
        { type: "mrkdwn", text: `*出品者*\n${it.offerCount ?? "-"}` },
        { type: "mrkdwn", text: `*ランキング*\n${it.salesRank ?? "-"}` },
        {
          type: "mrkdwn",
          text: `*30日販売数*\n${it.monthlySold ?? "-"}`,
        },
      ],
    });

    // Keepaグラフ画像を「表示」
    if (it.graphImageUrl) {
      blocks.push({
        type: "image",
        image_url: it.graphImageUrl,
        alt_text: `Keepa graph ${it.asin}`,
      });
    }

    // ボタン
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

    blocks.push({ type: "divider" });
  }

  return blocks;
}

/* =========================
   Keepa fetch
========================= */
async function fetchAsins(profile) {
  const out = [];
  let page = 0;

  while (page < FINDER_MAX_PAGES) {
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

    for (const a of list) if (!out.includes(a)) out.push(a);
    if (list.length < FINDER_PER_PAGE) break;
    page++;
  }

  return out.slice(0, PROFILE_LIMIT * 10);
}

/* =========================
   process profile
========================= */
async function processProfile(profile, remaining) {
  log(`profile START ${profile.name}`);

  const asins = await fetchAsins(profile);
  const picked = [];

  for (const ch of chunk(asins, 20)) {
    if (picked.length >= remaining) break;

    const res = await keepaProduct(ch, { statsDays: 90 });
    for (const p of res.products || []) {
      if (profile.excludeDigital && isDigitalTitle(p.title)) continue;

      const stats = p.stats || {};
      const { amazonPrice } = getStatsBasics(stats);
      if (amazonPrice) continue;

      const offers = getTotalOfferCount(stats);
      if (offers == null || offers < 3) continue;

      picked.push(buildItemView(p));
      if (picked.length >= PROFILE_LIMIT) break;
    }
  }

  if (!picked.length) {
    log(`profile DONE ${profile.name} notified=0`);
    return 0;
  }

  for (const group of chunk(picked, SLACK_BATCH)) {
    await slack({
      text: `${profile.name}｜${group.length}件`,
      blocks: buildBlocks(profile.name, group),
    });
  }

  log(`profile DONE ${profile.name} notified=${picked.length}`);
  return picked.length;
}

/* =========================
   main
========================= */
async function main() {
  log(`monitor START (ONLY_PROFILE=${ONLY_PROFILE ?? "all"})`);

  let remaining = MAX_NOTIFY;
  const targets = ONLY_PROFILE
    ? PROFILES.filter((p) => p.key === ONLY_PROFILE)
    : PROFILES;

  for (const p of targets) {
    if (remaining <= 0) break;
    remaining -= await processProfile(p, remaining);
  }

  log("monitor DONE");
}

main().catch((e) => {
  console.error("monitor FATAL", e);
  process.exitCode = 1;
});
