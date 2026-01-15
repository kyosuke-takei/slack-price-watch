// cloud/src/jobs/monitor.js
// Slack Price Monitor (cloud) - with state (diff-only notify)
// - ONLY_PROFILE (toys/games/hobby) supported
// - 429 Too Many Requests: wait refillIn then retry
// - Product image: yes
// - Buttons (Amazon/Keepa): bottom
// - Diff-only notify by comparing with previous state (price/sellers/rank/sold30)
// - Anti-spam: cooldown hours per ASIN

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// diff / state
const STATE_FILE = process.env.STATE_FILE || "cloud/data/state.json";

// threshold / cooldown
const PRICE_DELTA_YEN = numEnv("PRICE_DELTA_YEN", 200); // price change >= 200 yen triggers notify
const RANK_DELTA_ABS = numEnv("RANK_DELTA_ABS", 5000); // rank change >= 5000 triggers notify
const SELLERS_DELTA_ABS = numEnv("SELLERS_DELTA_ABS", 1); // sellers change >= 1 triggers notify
const SOLD30_DELTA_ABS = numEnv("SOLD30_DELTA_ABS", 5); // sold30 change >= 5 triggers notify
const NOTIFY_COOLDOWN_HOURS = numEnv("NOTIFY_COOLDOWN_HOURS", 6); // same asin won't re-notify within N hours

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
// NOTE: GitHub Actionsのマスク暴発を避けるため ISO日時ではなくUNIX秒を使う
function log(...args) {
  const ts = Math.floor(Date.now() / 1000);
  console.log(`[${ts}]`, ...args);
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
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function absDelta(a, b) {
  if (a == null || b == null) return null;
  const da = Number(a);
  const db = Number(b);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return null;
  return Math.abs(da - db);
}
function ensureDirForFile(filepath) {
  const dir = path.dirname(filepath);
  fs.mkdirSync(dir, { recursive: true });
}

/* =========================
 * state (read/write)
 * ========================= */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { version: 1, updatedAt: nowSec(), asins: {} };
    }
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") throw new Error("state invalid object");
    if (!obj.asins || typeof obj.asins !== "object") obj.asins = {};
    if (!obj.version) obj.version = 1;
    return obj;
  } catch (e) {
    log("state load failed -> start fresh", e?.message || e);
    return { version: 1, updatedAt: nowSec(), asins: {} };
  }
}

function saveState(state) {
  try {
    ensureDirForFile(STATE_FILE);
    state.updatedAt = nowSec();
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, STATE_FILE);
    log("state saved", { file: STATE_FILE, asinCount: Object.keys(state.asins || {}).length });
  } catch (e) {
    log("state save failed", e?.message || e);
  }
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
function shouldNotifyByDiff(prev, cur) {
  // first time -> notify (but still subject to cooldown if prev exists)
  if (!prev) return { ok: true, reasons: ["new"] };

  const reasons = [];

  const pd = absDelta(prev.price, cur.price);
  if (pd != null && pd >= PRICE_DELTA_YEN) reasons.push(`priceΔ${pd}`);

  const sd = absDelta(prev.sellers, cur.sellers);
  if (sd != null && sd >= SELLERS_DELTA_ABS) reasons.push(`sellersΔ${sd}`);

  const rd = absDelta(prev.rank, cur.rank);
  if (rd != null && rd >= RANK_DELTA_ABS) reasons.push(`rankΔ${rd}`);

  const dd = absDelta(prev.sold30, cur.sold30);
  if (dd != null && dd >= SOLD30_DELTA_ABS) reasons.push(`sold30Δ${dd}`);

  return { ok: reasons.length > 0, reasons };
}

function isInCooldown(prev) {
  if (!prev?.lastNotifiedAt) return false;
  const cooldownSec = NOTIFY_COOLDOWN_HOURS * 3600;
  return nowSec() - prev.lastNotifiedAt < cooldownSec;
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

  // 数値情報（日本語）
  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*価格*\n${it.price != null ? yen(it.price) : "-"}` },
      { type: "mrkdwn", text: `*出品者*\n${it.sellers ?? "-"}人` },
      { type: "mrkdwn", text: `*ランキング*\n${it.rank ?? "-"}位` },
      { type: "mrkdwn", text: `*30日販売数*\n${it.sold30 ?? "-"}個` },
    ],
  });

  // 変更理由
  if (it.diffReasons?.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `変更検知: ${it.diffReasons.map((x) => `\`${x}\``).join(" ")}` }],
    });
  }

  // ボタン（下）
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
    return 0;
  }

  const asinChunks = chunk(asins, 20);
  const picked = [];

  let scanned = 0;
  let skippedCooldown = 0;
  let skippedNoDiff = 0;

  for (const ch of asinChunks) {
    if (picked.length >= remainingNotify) break;

    let res;
    try {
      res = await withRetry(() => keepaProduct(ch, { statsDays: 90 }), {
        label: `keepaProduct:${profile.key}`,
        maxRetries: 10,
      });
    } catch (e) {
      // ここで落とさずカテゴリ継続
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

      const cur = {
        asin: p.asin,
        title: normalizeTitle(p.title),
        price,
        sellers,
        rank: salesRank,
        sold30: monthlySold,
        amazonUrl: `https://www.amazon.co.jp/dp/${p.asin}`,
        keepaUrl: keepaProductPageUrl(p.asin),
        imageUrl: getMainImageUrl(p),
      };

      const prev = state.asins?.[cur.asin];

      // cooldown
      if (prev && isInCooldown(prev)) {
        skippedCooldown += 1;
        // stateは更新だけしておく（値は追従）
        state.asins[cur.asin] = { ...prev, ...pickStateFields(cur), lastSeenAt: nowSec() };
        continue;
      }

      // diff
      const diff = shouldNotifyByDiff(prev, cur);
      if (!diff.ok) {
        skippedNoDiff += 1;
        // 通知しないが state は更新
        state.asins[cur.asin] = { ...(prev || {}), ...pickStateFields(cur), lastSeenAt: nowSec() };
        continue;
      }

      // notify item
      picked.push({ ...cur, diffReasons: diff.reasons });

      // stateを通知済みに更新
      state.asins[cur.asin] = {
        ...(prev || {}),
        ...pickStateFields(cur),
        lastNotifiedAt: nowSec(),
        lastSeenAt: nowSec(),
      };

      if (picked.length >= PROFILE_LIMIT || picked.length >= remainingNotify) break;
    }
  }

  if (!picked.length) {
    log(
      `profile DONE ${profile.name} (no diff items) scanned=${scanned} cooldownSkip=${skippedCooldown} noDiff=${skippedNoDiff}`
    );
    return 0;
  }

  const sent = await postToSlack(profile.name, picked);
  log(
    `profile DONE ${profile.name} notified=${sent} picked=${picked.length} scanned=${scanned} cooldownSkip=${skippedCooldown} noDiff=${skippedNoDiff}`
  );
  return sent;
}

function pickStateFields(cur) {
  return {
    title: cur.title,
    price: cur.price ?? null,
    sellers: cur.sellers ?? null,
    rank: cur.rank ?? null,
    sold30: cur.sold30 ?? null,
    amazonUrl: cur.amazonUrl,
    keepaUrl: cur.keepaUrl,
    imageUrl: cur.imageUrl ?? null,
  };
}

/* =========================
 * main
 * ========================= */
async function main() {
  log(`monitor START (ONLY_PROFILE=${ONLY_PROFILE || "all"})`);

  // load state
  const state = loadState();
  if (!state.asins) state.asins = {};

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
    const used = await processProfile(profile, remaining, state);
    remaining -= used;
    totalNotified += used;
  }

  // save state at end
  saveState(state);

  log(`monitor DONE notified=${totalNotified}`);
}

main().catch((err) => {
  console.error("monitor FATAL", err?.message || err);
  process.exitCode = 1;
});
