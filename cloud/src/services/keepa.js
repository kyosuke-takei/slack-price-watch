// src/services/keepa.js
// Keepa API ラッパー（Finder / Product / グラフURL）

import "dotenv/config";

const API = "https://api.keepa.com";
const KEY = process.env.KEEPA_API_KEY;
const DOMAIN = Number(process.env.KEEPA_DOMAIN || 5); // 5 = JP

if (!KEY) {
  throw new Error("KEEPA_API_KEY is required");
}

const toJson = async (res) => {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Keepa ${res.status} ${res.statusText} - ${body.slice(0, 500)}`
    );
  }
  return res.json();
};

/**
 * Finder: POST /query
 * payload は Keepa Finder の JSON をそのまま渡す想定
 */
export async function keepaQuery(payload) {
  const url = `${API}/query?key=${encodeURIComponent(KEY)}&domain=${DOMAIN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return toJson(res);
}

/**
 * Product: GET /product
 *  - asins: string[]
 *  - options.statsDays: statsDays（例：7, 30, 90）
 *  - options.buybox: true のときだけ buybox=1 を付与
 */
export async function keepaProduct(asins, options = {}) {
  if (!asins?.length) return { products: [] };

  const statsDays = options.statsDays ?? 7;

  const params = new URLSearchParams({
    key: KEY,
    domain: String(DOMAIN),
    asin: asins.join(","), // カンマ区切り ASIN
    stats: String(statsDays),
  });

  if (options.buybox) {
    params.set("buybox", "1");
  }

  const url = `${API}/product?${params.toString()}`;
  const res = await fetch(url);
  return toJson(res);
}

/**
 * Keepaグラフ画像URL生成（Slack用）
 * - width / height は Keepa の仕様に合わせて 300〜1000px にクランプ
 * - domain は co.jp 固定
 */
export function buildKeepaGraphUrl({ asin, rangeDays, width, height }) {
  const url = new URL("https://graph.keepa.com/pricehistory.png");

  url.searchParams.set("asin", asin);
  url.searchParams.set("domain", "co.jp");

  const w = Math.max(300, Math.min(width, 1000));
  const h = Math.max(150, Math.min(height, 1000));
  url.searchParams.set("width", String(w));
  url.searchParams.set("height", String(h));

  url.searchParams.set("range", String(rangeDays)); // 日数
  url.searchParams.set("bb", "1"); // BuyBox
  url.searchParams.set("amazon", "1"); // Amazon
  url.searchParams.set("new", "1"); // 新品
  url.searchParams.set("used", "0"); // 中古非表示
  url.searchParams.set("salesrank", "1"); // ランキング線

  return url.toString();
}

/** Keepa商品ページURL */
export function keepaProductPageUrl(asin) {
  return `https://keepa.com/#!product/${DOMAIN}-${asin}`;
}
