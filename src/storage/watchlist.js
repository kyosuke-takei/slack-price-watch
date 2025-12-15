// src/storage/watchlist.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILE = path.resolve(__dirname, "../../data/watchlist.json");

export function watchlistAbsPath() { return FILE; }

export function loadWatchlist() {
  if (!fs.existsSync(FILE)) return { asinList: [] };
  try { return JSON.parse(fs.readFileSync(FILE, "utf-8")); }
  catch { return { asinList: [] }; }
}

export function saveWatchlist(json) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(json, null, 2), "utf-8");
}

export function addAsins(asins) {
  const w = loadWatchlist();
  const set = new Set(w.asinList || []);
  for (const a of asins) if (a) set.add(String(a).trim());
  const next = { asinList: [...set] };
  saveWatchlist(next);
  return next;
}
