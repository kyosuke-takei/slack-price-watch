import fs from "fs";
const FILE = "data/state.json";

export function loadState() {
  if (!fs.existsSync(FILE)) return { products: {} };
  return JSON.parse(fs.readFileSync(FILE, "utf-8"));
}

export function saveState(s) {
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2), "utf-8");
}
