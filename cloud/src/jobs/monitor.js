// cloud/src/jobs/monitor.js
// Monitor ALL categories → notify ONLY on changes

import "dotenv/config";
import fs from "fs";
import path from "path";
import {
  keepaQuery,
  keepaProduct,
  keepaProductPageUrl,
} from "../services/keepa.js";
import { slack } from "../services/slack.js";

/* =====================
   paths
===================== */
const DATA_DIR = path.resolve("cloud/data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const prevState = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"))
  : {};

/* =====================
   env
===================== */
const DOMAIN = Number(process.env.KEEPA_DOMAIN || 5);
const FINDER_PER_PAGE = 100;
const FINDER_MAX_PAGES = 5;
const SLACK_BATCH = 3;

/* =====================
   profiles
===================== */
const PROFILES = [
  { key: "toys", name: "おもちゃ", rootCategory: 13299531 },
  { key: "games", name: "ゲーム", rootCategory: 637394, excludeDigital: true },
  { key: "hobby", name: "ホビー", rootCategory: 2277721051 },
];

/* =====================
   utils
===================== */
const log = (...a) => console.log(new Date().toISOString(), ...a);

const DIGITAL_WORDS = ["download", "ダウンロード", "オンラインコード"];
const isDigital = (t = "") =>
  DIGITAL_WORDS.some((k) => t.toLowerCase().includes(k));

const chunk = (a, n) =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) =>
    a.slice(i * n, i * n + n)
  );

const yen = (v) =>
  v != null && Number.isFinite(v) ? `¥${v.toLocaleString("ja-JP")}` : "-";

const imageUrl = (p) => {
  const csv = p?.imagesCSV;
  if (!csv) return null;
  const id = csv.split(",")[0];
  return id ? `https://m.media-amazon.com/images/I/${id}.jpg` : null;
};

/* =====================
   change detection
===================== */
function detectChange(prev, curr) {
  const changes = [];

  if (prev) {
    if (curr.sellers < prev.sellers) {
      changes.push(`出品者: ${prev.sellers} → ${curr.sellers} ⬇️`);
    }
    if (curr.price != null && prev.price != null && curr.price > prev.price) {
      changes.push(`価格: ${yen(prev.price)} → ${yen(curr.price)} ⬆️`);
    }
    if (curr.rank != null && prev.rank != null && curr.rank < prev.rank) {
      changes.push(`ランキング: ${prev.rank} → ${curr.rank} ⬆️`);
    }
  }

  return changes;
}

/* =====================
   slack blocks
===================== */
function buildBlocks(profileName, item) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `📈 変化検知（${profileName}）` },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${item.title}*` },
      accessory: item.imageUrl
        ? {
            type: "image",
            image_url: item.imageUrl,
            alt_text: item.title.slice(0, 80),
          }
        : undefined,
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: item.changes.join("\n") },
    },
    {
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
    },
  ];

  return blocks;
}

/* =====================
   main
===================== */
(async () => {
  log("monitor START");

  const nextState = { ...prevState };

  for (const profile of PROFILES) {
    log(`profile START ${profile.name}`);

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
      list.forEach((a) => !asins.includes(a) && asins.push(a));
      if (list.length < FINDER_PER_PAGE) break;
    }

    for (const group of chunk(asins, 20)) {
      const res = await keepaProduct(group, { statsDays: 90 });
      const products = res?.products || [];

      for (const p of products) {
        if (!p?.asin) continue;
        if (profile.excludeDigital && isDigital(p.title)) continue;

        const stats = p.stats || {};
        const price = stats.current?.[1] ?? null;
        const rank = stats.current?.[3] ?? null;
        const sellers = stats.totalOfferCount ?? 0;

        if (sellers < 3) continue;

        const curr = { price, rank, sellers };
        const prev = prevState[p.asin];

        const changes = detectChange(prev, curr);
        if (!changes.length) {
          nextState[p.asin] = curr;
          continue;
        }

        await slack({
          text: `${profile.name} 変化検知`,
          blocks: buildBlocks(profile.name, {
            title: p.title,
            imageUrl: imageUrl(p),
            changes,
            amazonUrl: `https://www.amazon.co.jp/dp/${p.asin}`,
            keepaUrl: keepaProductPageUrl(p.asin),
          }),
        });

        nextState[p.asin] = curr;
      }
    }

    log(`profile DONE ${profile.name}`);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
  log("monitor DONE");
})().catch((e) => {
  console.error("monitor FATAL", e);
  process.exitCode = 1;
});
