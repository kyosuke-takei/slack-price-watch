// src/jobs/monitor_hobby.js
// 「ホビー」だけを監視してSlack投稿する

import "dotenv/config";
import { runProfile } from "./lib/core.js";
import { loadWatchlist } from "../storage/watchlist.js";

function pickHobbyProfile(profiles) {
  // watchlist内の profile.name が「ホビー」を含むものを優先
  const byName = profiles.find((p) => String(p.name || "").includes("ホビー"));
  if (byName) return byName;

  // それでも無ければ id/slug 的なキーで探す
  const byKey = profiles.find((p) => ["hobby", "hobbies"].includes(String(p.key || p.id || "").toLowerCase()));
  if (byKey) return byKey;

  throw new Error("Hobby profile not found in watchlist.json");
}

async function main() {
  console.log(new Date().toISOString(), "monitor_hobby START");

  const watchlist = await loadWatchlist(); // data/watchlist.json を読む想定（あなたの既存）
  const profiles = watchlist?.profiles || watchlist?.profile || [];
  const hobby = pickHobbyProfile(profiles);

  const notified = await runProfile(hobby);

  console.log(new Date().toISOString(), `monitor_hobby DONE notified=${notified ?? 0}`);
}

main().catch((e) => {
  console.error("monitor_hobby ERROR", e);
  process.exit(1);
});
