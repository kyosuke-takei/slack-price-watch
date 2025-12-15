// src/jobs/discover.js
// 指定の Keepa Product Finder クエリで取得 → そのまま（整形せず）Slackへ投稿
// 必要な .env: KEEPA_API_KEY / KEEPA_DOMAIN(=5) / SLACK_WEBHOOK_URL

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, "../../");
const SEEDS_PATH = path.join(ROOT, "data/seeds.json"); // 任意：finderの上書きに使える

const API_KEY = process.env.KEEPA_API_KEY;
const DOMAIN  = Number(process.env.KEEPA_DOMAIN || 5);
const WEBHOOK = process.env.SLACK_WEBHOOK_URL || "";

if (!API_KEY) { console.error("❌ KEEPA_API_KEY 未設定"); process.exit(1); }
if (!WEBHOOK) { console.error("❌ SLACK_WEBHOOK_URL 未設定"); process.exit(1); }

const BASE = "https://api.keepa.com";
const now  = () => new Date().toISOString();

// ▼あなたが指定した Finder クエリ（page はループで上書き）
const BASE_QUERY = {
  current_SALES_gte: 1,
  current_SALES_lte: 10000,
  rootCategory: ["13299531"],                // おもちゃ
  deltaPercent7_BUY_BOX_SHIPPING_gte: -1000, // 7日で値下がり（送料込み）
  deltaPercent7_BUY_BOX_SHIPPING_lte: -15,
  buyBoxStatsAmazon365_gte: 1,
  buyBoxStatsAmazon365_lte: 100,
  current_AMAZON_gte: -1,                    // -1 = データ無し（在庫切れ）
  current_AMAZON_lte: -1,
  current_NEW_gte: 1000,                     // 新品価格 >= 1000（1/100通貨単位）
  sort: [
    ["current_SALES", "asc"],
    ["monthlySold", "desc"]
  ],
  productType: [0, 1, 2],
  perPage: 100,
  page: 0
};

// 任意：data/seeds.json に { "finder": { ... } } を置けば、上のクエリを上書きできます
function loadFinderOverride() {
  try {
    if (!fs.existsSync(SEEDS_PATH)) return {};
    const j = JSON.parse(fs.readFileSync(SEEDS_PATH, "utf-8"));
    return (j && typeof j.finder === "object") ? j.finder : {};
  } catch {
    return {};
  }
}

// Slack: テキスト分割（整形なしでそのまま投げる）
const SLACK_TEXT_LIMIT = 3500;

async function postSlackText(text) {
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const er = await res.text().catch(() => "");
    console.error(now(), "Slack post failed:", res.status, er);
  }
}

async function postSlackJSON(obj, prefix = "") {
  const s = (prefix ? `${prefix}\n` : "") + JSON.stringify(obj);
  if (s.length <= SLACK_TEXT_LIMIT) {
    await postSlackText(s);
  } else {
    for (let i = 0; i < s.length; i += SLACK_TEXT_LIMIT) {
      await postSlackText(s.slice(i, i + SLACK_TEXT_LIMIT));
    }
  }
}

// Keepa Finder呼び出し
async function finderQuery(query) {
  const url = `${BASE}/query?key=${encodeURIComponent(API_KEY)}&domain=${DOMAIN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Keepa /query HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`Keepa /query error ${JSON.stringify(data.error)}`);
  return data;
}

function toAsins(data) {
  if (Array.isArray(data?.asinList)) return data.asinList;
  if (Array.isArray(data?.products)) return data.products.map(p => p?.asin).filter(Boolean);
  if (Array.isArray(data?.productIds)) return data.productIds;
  return [];
}

(async () => {
  console.log(now(), "discover (finder->slack) START");
  console.log("ROOT:", ROOT);

  // rootCategory を数値に正規化
  const root = (BASE_QUERY.rootCategory || []).map(x => Number(x));
  const override = loadFinderOverride();
  const q0 = { ...BASE_QUERY, ...override, rootCategory: root };

  const perPage = Number.isFinite(q0.perPage) ? q0.perPage : 100;
  let page = Number.isFinite(q0.page) ? q0.page : 0;
  let sentAcc = 0;

  // 先頭に条件概要をそのまま投稿
  await postSlackJSON({ info: "Finder条件", query: q0 });

  for (;;) {
    const q = { ...q0, page };
    const data = await finderQuery(q);

    // ページ情報を先に1行で
    const totalResults = Number.isFinite(data?.totalResults) ? data.totalResults : null;
    if (page === q0.page) {
      const totalPages = totalResults ? Math.ceil(totalResults / perPage) : null;
      await postSlackJSON({ page0: { totalResults, perPage, totalPages } });
    }

    // 取得した生JSONをそのままSlackへ（整形なし）
    await postSlackJSON(data, `page=${page}`);

    const got = toAsins(data).length;
    sentAcc += got;
    console.log(now(), `page=${page} asins=${got} sentAcc=${sentAcc}`);

    if (got < perPage) break; // 最終ページ
    page += 1;
    await new Promise(r => setTimeout(r, 250)); // レート緩和
  }

  console.log(now(), "discover (finder->slack) DONE:", "sent=", sentAcc);
})().catch(e => {
  console.error("致命的エラー:", e?.message || e);
  process.exit(1);
});
