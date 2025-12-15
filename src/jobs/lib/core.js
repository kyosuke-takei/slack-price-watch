// src/jobs/lib/core.js  --- streaming型でカテゴリ厳密収集に刷新
import "dotenv/config";
import { keepaQuery, keepaProduct } from "../../services/keepa.js";

// ========= ENV =========
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const KEEPADOMAIN = Number(process.env.KEEPA_DOMAIN || 5);
const TZ = "Asia/Tokyo";

const FINDER_PER_PAGE = Number(process.env.FINDER_PER_PAGE || 100);
const FINDER_MAX_PAGES = Number(process.env.FINDER_MAX_PAGES || 20);

const SLACK_BATCH = Number(process.env.SLACK_BATCH || 10);
const MAX_NOTIFY   = Number(process.env.MAX_NOTIFY   || 50);

// Finderクエリをハードニング（カテゴリ厳密化）
const STRICT_FINDER = String(process.env.STRICT_FINDER || "on").toLowerCase() === "on";
// /product 後のカテゴリ一致チェック
const STRICT_CATEGORY_MATCH = String(process.env.STRICT_CATEGORY_MATCH || "on").toLowerCase() === "on";

// ========= Slack =========
export async function slack({ text, blocks }) {
  if (!SLACK_WEBHOOK_URL) { console.log(ts(), "WARN Slack未設定"); return; }
  const ctl = new AbortController(); const to = setTimeout(()=>ctl.abort(), 15000);
  try{
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method:"POST", headers:{ "content-type":"application/json" },
      body: JSON.stringify(blocks ? { text: text ?? "notification", blocks } : { text: text ?? "notification" }),
      signal: ctl.signal
    });
    clearTimeout(to);
    if (!res.ok) console.log(ts(), "ERR Slack", res.status, await res.text().catch(()=>"" ));
    else console.log(ts(), "Slack ok", res.status);
  }catch(e){ clearTimeout(to); console.log(ts(), "ERR Slack", e?.message||e); }
}
export const headerBlock = (title)=>[{ type:"section", text:{ type:"mrkdwn", text:`*${title}*` } }, { type:"divider" }];
export const itemBlock = (it)=>{
  const lines = [
    `*${it.title}*  <${it.url}|Amazon> ・ <${it.keepa}|Keepa>  (${it.asin})`
  ];
  lines.push(`ランキング: *${it.rank ?? "不明"}*`);
  lines.push(`現在価格(送料込): ${it.priceJpy ?? "不明"}（7日前: ${it.pastJpy ?? "不明"}）`);
  lines.push(`7日変化: ${it.changePctStr ?? "?"}`);
  lines.push(`Amazon在庫: ${it.amazonOOS ? "なし" : "あり"} ｜ BuyBox: ${it.bbIsAmazon ? "Amazon" : "3P"}`);
  if (it.catNote) lines.push(`_(注: ${it.catNote})_`);
  return [{ type:"section", text:{ type:"mrkdwn", text:lines.join("\n") } }, { type:"divider" }];
};

// ========= Utils =========
export const ts   = ()=> new Date().toISOString();
export const jpNow= ()=> new Date().toLocaleString("ja-JP",{ timeZone: TZ });
export const urlOf    = (asin)=> `https://www.amazon.co.jp/dp/${asin}`;
export const keepaUrl = (asin)=> `https://keepa.com/#!product/${KEEPADOMAIN}-${asin}`;

// Keepa time (minutes since 2011-01-01 UTC)
const KEEPABASE_MIN = Date.UTC(2011,0,1)/60000;
const getCur = (cur, ...keys)=>{ for (const k of keys){ if (cur && Number.isFinite(cur[k])) return cur[k]; } return null; };
const valueAtOrBefore = (arr, targetMin)=>{
  if (!Array.isArray(arr) || arr.length < 2) return null;
  let last = null;
  for (let i=0;i<arr.length;i+=2){
    const t = arr[i], v = arr[i+1];
    if (typeof t !== "number") continue;
    if (t > targetMin) break;
    if (typeof v === "number") last = v;
  }
  return last;
};
const currentLandedPrice = (p)=>{
  const cur = p?.stats?.current || {};
  const price = getCur(cur, "buyBoxPrice", "BUY_BOX");
  const ship  = getCur(cur, "buyBoxShipping", "BUY_BOX_SHIPPING");
  if (price > 0 && ship !== null && ship >= 0) return (price + ship) / 100;
  const alt = getCur(cur, "newPrice","NEW","amazonPrice","AMAZON","usedPrice","USED") || 0;
  return alt > 0 ? alt/100 : null;
};
const landedPrice7dAgo = (p)=>{
  const minutesNow = Date.now()/60000;
  const targetMin = Math.floor(minutesNow - 7*24*60 - KEEPABASE_MIN);
  const bbP = valueAtOrBefore(p?.buyBoxPrice, targetMin);
  const bbS = valueAtOrBefore(p?.buyBoxShipping, targetMin);
  if (typeof bbP === "number" && bbP>0 && typeof bbS === "number" && bbS>=0) return (bbP+bbS)/100;
  for (const k of ["buyBoxPrice","newPrice","amazonPrice","usedPrice"]){
    const v = valueAtOrBefore(p?.[k], targetMin);
    if (typeof v === "number" && v>0) return v/100;
  }
  return null;
};
const amazonOOS = (p)=> !(getCur(p?.stats?.current||{}, "amazonPrice","AMAZON") > 0);
const buyBoxIsAmazon = (p)=>{
  const cur = p?.stats?.current || {};
  if (typeof cur.buyBoxIsAmazon === "boolean") return cur.buyBoxIsAmazon;
  if (typeof p?.buyBoxIsAmazon  === "boolean") return p.buyBoxIsAmazon;
  const ap = getCur(cur,"amazonPrice","AMAZON");
  const bb = getCur(cur,"buyBoxPrice","BUY_BOX");
  return !!(ap && bb && ap===bb);
};
const currentRank = (p)=>{
  const cr = getCur(p?.stats?.current||{}, "salesRank","SALES");
  if (cr && cr>0) return cr;
  const root = p?.rootCategory;
  const ranks = p?.salesRanks?.[String(root)] || p?.salesRanks?.[root];
  if (Array.isArray(ranks) && ranks.length>=2){
    for (let i=ranks.length-2;i>=0;i-=2){
      const r = ranks[i+1];
      if (Number.isFinite(r) && r>0) return r;
    }
  }
  return null;
};

// ルートカテゴリ厳密判定
const isInRoot = (p, rootId)=>{
  if (!p) return false;
  if (p.rootCategory === rootId) return true;
  if (Array.isArray(p.categories) && p.categories.includes(rootId)) return true;
  if (p.salesRanks && (String(rootId) in p.salesRanks || rootId in p.salesRanks)) return true;
  return false;
};

// ========= /product =========
async function fetchProducts(asins){
  const out = [];
  const CHUNK = 20;
  for (let i=0;i<asins.length;i+=CHUNK){
    const chunk = asins.slice(i, i+CHUNK);
    console.log(ts(), `product fetch ${i+1}-${i+chunk.length}/${asins.length}`);
    try{
      const products = await keepaProduct(chunk);
      if (Array.isArray(products)) out.push(...products);
    }catch(e){
      console.log(ts(), "ERR keepaProduct:", e?.message||e);
    }
    await new Promise(r=>setTimeout(r, 150));
  }
  return out;
}

// ========= ストリーミング型パイプライン =========
// ページごとにASIN → /product → カテゴリ厳密チェック → 十分に貯まったら終了
export async function runProfile({ tag, root, buildQuery, limit = 10 }){
  console.log(ts(), `runProfile START ${tag}`);
  const accepted = [];
  const seenAsin = new Set();

  for (let page=0; page<FINDER_MAX_PAGES && accepted.length<limit; page++){
    let q = buildQuery(page);

    // 正規化 + カテゴリ強制（公式キー）
    q.rootCategory = [Number(root)]; // 保険で配列→数値化
    if (STRICT_FINDER){
      q.categories_include = Number(root); // keepa official（int）
      // salesRankReference は公式ドキュメントにないため使わない
    }

    // /query は selection で包むのがAPI仕様
    let data;
    try{
      data = await keepaQuery({ selection: { ...q, perPage: q.perPage ?? FINDER_PER_PAGE, page } });
    }catch(e){
      console.log(ts(), `[finder:${tag}] ERR`, e?.message||e);
      break;
    }

    if (page===0){
      const tr = Number.isFinite(data?.totalResults) ? data.totalResults : "?";
      console.log(ts(), `[finder:${tag}] totalResults=${tr} perPage=${q.perPage ?? FINDER_PER_PAGE}`);
    }

    const asins =
      Array.isArray(data?.asinList)   ? data.asinList :
      Array.isArray(data?.products)   ? data.products.map(p=>p?.asin).filter(Boolean) :
      Array.isArray(data?.productIds) ? data.productIds : [];

    console.log(ts(), `[finder:${tag}] page=${page} got=${asins.length}`);

    // 未取得ASINだけ詳細取得
    const newAsins = asins.map(String).filter(a => a && !seenAsin.has(a));
    newAsins.forEach(a => seenAsin.add(a));
    if (!newAsins.length) continue;

    const products = await fetchProducts(newAsins);

    for (const p of products){
      // 厳密カテゴリチェック（ENV on の場合）
      if (STRICT_CATEGORY_MATCH && !isInRoot(p, root)) continue;

      const asin = p.asin;
      const title = p.title || "Untitled";
      const cur = currentLandedPrice(p);
      const past = landedPrice7dAgo(p);
      const change = (cur && past && past>0) ? (cur-past)/past : null;

      let catNote = null;
      if (!STRICT_CATEGORY_MATCH && !(p.rootCategory === root)){
        const maybe = (Array.isArray(p.categories) && p.categories.includes(root)) ||
                      (p.salesRanks && (String(root) in p.salesRanks || root in p.salesRanks));
        if (!maybe) catNote = `Finderは ${tag} だが、商品カテゴリは異なる可能性あり (root=${p.rootCategory})`;
      }

      accepted.push({
        asin,
        title,
        url: urlOf(asin),
        keepa: keepaUrl(asin),
        rank: currentRank(p),
        amazonOOS: amazonOOS(p),
        bbIsAmazon: buyBoxIsAmazon(p),
        priceJpy: cur  ? `${Math.round(cur ).toLocaleString()} 円` : null,
        pastJpy:  past ? `${Math.round(past).toLocaleString()} 円` : null,
        changePctStr: change!==null ? `${(Math.round(change*1000)/10)}%` : null,
        catNote,
      });
      if (accepted.length >= Math.min(limit, MAX_NOTIFY)) break;
    }
  }

  if (!accepted.length){
    await slack({ text: `${tag}：カテゴリ一致により0件（${jpNow()}）` });
    console.log(ts(), `runProfile DONE ${tag} notified=0`);
    return 0;
  }

  const top = accepted.slice(0, Math.min(limit, MAX_NOTIFY));
  const title = `${tag} 上位${top.length}件  ${jpNow()}`;
  for (let i=0;i<top.length;i+=SLACK_BATCH){
    const slice = top.slice(i, i+SLACK_BATCH);
    const blocks = [
      ...headerBlock(`${title}  ${i+1}-${i+slice.length}/${top.length}`),
      ...slice.flatMap(itemBlock)
    ];
    await slack({ blocks });
  }

  console.log(ts(), `runProfile DONE ${tag} notified=${top.length}`);
  return top.length;
}
