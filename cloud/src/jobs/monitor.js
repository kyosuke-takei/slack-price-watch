// src/jobs/monitor.js
// Keepa Finder → Product → Slack 通知
// ✅ 商品画像あり / ❌ Keepaグラフなし / 独自Slackレイアウト

import "dotenv/config";
import {
  keepaQuery,
  keepaProduct,
  keepaProductPageUrl,
} from "../services/keepa.js";
import { slack } from "../services/slack.js";

/* =====================
   環境変数
===================== */
const FINDER_PER_PAGE = Number(process.env.FINDER_PER_PAGE || 100);
const FINDER_MAX_PAGES = Number(process.env.FINDER_MAX_PAGES || 5);
const SLACK_BATCH = Math.min(Math.max(Number(process.env.SLACK_BATCH || 3), 1), 3);
const MAX_NOTIFY = Number(process.env.MAX_NOTIFY || 30);
const DOMAIN = Number(process.env.KEEPA_DOMAIN || 5); // JP

/* =====================
   プロファイル定義
===================== */
const PROFILES = [
  { name: "おもちゃ", rootCategory: 13299531, limit: 30, excludeDigital: false },
  { name: "ゲーム", rootCategory: 637394, limit: 30, excludeDigital: true },
  { name: "ホビー", rootCategory: 2277721051, limit: 30, excludeDigital: false },
];

const DIGITAL_KEYWORDS = [
  "ダウンロード",
  "オンラインコード",
  "download",
  "digital",
];

/* =====================
   util
===================== */
const log = (...a) => console.log(new Date().toISOString(), ...a);

const yen = (v) =>
  v != null && Number.isFinite(v)
    ? `¥${Number(v).toLocaleString("ja-JP")}`
    : "-";

const isDigitalTitle = (title = "") =>
  DIGITAL_KEYWORDS.some((k) =>
    title.toLowerCase().includes(k.toLowerCase())
  );

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );

// 商品画像URL（Amazon CDN）
function getImageUrl(product) {
  const csv = product?.imagesCSV;
  if (!csv) return null;
  const id = csv.split(",")[0];
  return id
    ? `https://m.media-amazon.com/images/I/${id}.jpg`
    : null;
}

/* =====================
   Finder
===================== */
async function fetchAsins(profile) {
  const asins = [];

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

    for (const asin of list) {
      if (!asins.includes(asin)) asins.push(asin);
    }

    if (list.length < FINDER_PER_PAGE) break;
  }

  return asins.slice(0, profile.limit * 10);
}

/* =====================
   Slack Blocks
===================== */
function buildBlocks(profileName, items) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: profileName },
    },
    { type: "divider" },
  ];

  for (const it of items) {
    const section = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${it.title}*`,
      },
    };

    // ✅ 商品画像（右側サムネ）
    if (it.imageUrl) {
      section.accessory = {
        type: "image",
        image_url: it.imageUrl,
        alt_text: it.title.slice(0, 80),
      };
    }

    blocks.push(
      /* --- Amazon / Keepa ボタン --- */
      {
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
      },

      /* --- 商品名 + 画像 --- */
      section,

      /* --- 数値情報（日本語） --- */
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*価格*\n${yen(it.price)}` },
          { type: "mrkdwn", text: `*出品者*\n${it.sellers ?? "-"}人` },
          { type: "mrkdwn", text: `*ランキング*\n${it.rank ?? "-"}位` },
          { type: "mrkdwn", text: `*30日販売数*\n${it.sold30 ?? "-"}個` },
        ],
      },
      { type: "divider" }
    );
  }

  return blocks;
}

/* =====================
   プロファイル処理
===================== */
async function runProfile(profile, remaining) {
  log(`profile START ${profile.name}`);

  const asins = await fetchAsins(profile);
  const picked = [];

  for (const group of chunk(asins, 20)) {
    if (picked.length >= remaining) break;

    const res = await keepaProduct(group, { statsDays: 90 });
    const products = res?.products || [];

    for (const p of products) {
      if (!p?.asin) continue;
      if (profile.excludeDigital && isDigitalTitle(p.title)) continue;

      const stats = p.stats || {};
      const amazonPrice = stats.current?.[0];
      const newPrice = stats.current?.[1];
      const rank = stats.current?.[3];
      const sellers = stats.totalOfferCount ?? 0;

      if (amazonPrice && amazonPrice > 0) continue;
      if (sellers < 3) continue;

      picked.push({
        asin: p.asin,
        title: p.title.replace(/\s+/g, " ").trim(),
        price: newPrice ?? null,
        sellers,
        rank,
        sold30: stats.salesRankDrops30 ?? null,
        amazonUrl: `https://www.amazon.co.jp/dp/${p.asin}`,
        keepaUrl: keepaProductPageUrl(p.asin),
        imageUrl: getImageUrl(p),
      });

      if (picked.length >= profile.limit) break;
    }
  }

  if (!picked.length) {
    log(`profile DONE ${profile.name} notified=0`);
    return 0;
  }

  for (const batch of chunk(picked, SLACK_BATCH)) {
    await slack({
      text: `${profile.name} 新着 ${batch.length}件`,
      blocks: buildBlocks(profile.name, batch),
    });
  }

  log(`profile DONE ${profile.name} notified=${picked.length}`);
  return picked.length;
}

/* =====================
   main
===================== */
(async () => {
  log("monitor START");

  let remaining = MAX_NOTIFY;
  for (const profile of PROFILES) {
    if (remaining <= 0) break;
    remaining -= await runProfile(profile, remaining);
  }

  log("monitor DONE");
})();
