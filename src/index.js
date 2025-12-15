// src/index.js
// 定期実行ランナー（monitor/discover を子プロセスとして起動）
// - .env の CHECK_INTERVAL_MIN / AUTO_DISCOVERY / DISCOVERY_INTERVAL_MIN を使用
// - 1回分の実行は子プロセスで完結（export の有無に依存しない）
// - 同時実行ガード（前回が終わってなければスキップ）
// - 次回実行までのカウントダウンをログ表示

import "dotenv/config";
import { spawn } from "node:child_process";

// ─────────────────────────────────────────────
// 設定
// ─────────────────────────────────────────────
const CHECK_INTERVAL_MIN = Number(process.env.CHECK_INTERVAL_MIN || 10);     // 監視ジョブの間隔（分）
const AUTO_DISCOVERY = String(process.env.AUTO_DISCOVERY || "off").toLowerCase() === "on";
const DISCOVERY_INTERVAL_MIN = Number(process.env.DISCOVERY_INTERVAL_MIN || 60); // ディスカバリ間隔（分）
const TZ = "Asia/Tokyo";

// ─────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────
const jpNow = () => new Date().toLocaleString("ja-JP", { timeZone: TZ });

function scheduleLog(name, minutes) {
  console.log(`[${jpNow()}] next ${name} in ${minutes} min`);
}

function spawnNode(scriptPath, args = []) {
  return spawn(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env: process.env,
  });
}

// ─────────────────────────────────────────────
// 同時実行ガード
// ─────────────────────────────────────────────
let monitorChild = null;
let discoverChild = null;

function isRunning(child) {
  return !!child && child.exitCode === null && child.killed === false;
}

// ─────────────────────────────────────────────
// 実行関数
// ─────────────────────────────────────────────
function runOnceMonitor() {
  if (isRunning(monitorChild)) {
    console.log(`[${jpNow()}] monitor skipped (previous run still in progress)`);
    return;
  }
  console.log(`[${jpNow()}] monitor tick`);
  monitorChild = spawnNode("src/jobs/monitor.js");
  monitorChild.on("exit", (code, signal) => {
    console.log(`[${jpNow()}] monitor exit code=${code}${signal ? ` signal=${signal}` : ""}`);
  });
}

function runOnceDiscover() {
  if (isRunning(discoverChild)) {
    console.log(`[${jpNow()}] discover skipped (previous run still in progress)`);
    return;
  }
  console.log(`[${jpNow()}] discover tick`);
  discoverChild = spawnNode("src/jobs/discover.js");
  discoverChild.on("exit", (code, signal) => {
    console.log(`[${jpNow()}] discover exit code=${code}${signal ? ` signal=${signal}` : ""}`);
  });
}

// ─────────────────────────────────────────────
// 起動直後のキック
// ─────────────────────────────────────────────
runOnceMonitor();
scheduleLog("monitor", CHECK_INTERVAL_MIN);

if (AUTO_DISCOVERY) {
  runOnceDiscover();
  scheduleLog("discover", DISCOVERY_INTERVAL_MIN);
}

// ─────────────────────────────────────────────
// 周期実行スケジューラ
// ─────────────────────────────────────────────
setInterval(() => {
  runOnceMonitor();
  scheduleLog("monitor", CHECK_INTERVAL_MIN);
}, Math.max(CHECK_INTERVAL_MIN, 0.05) * 60 * 1000); // 最小3秒相当の下限

if (AUTO_DISCOVERY) {
  setInterval(() => {
    runOnceDiscover();
    scheduleLog("discover", DISCOVERY_INTERVAL_MIN);
  }, Math.max(DISCOVERY_INTERVAL_MIN, 0.05) * 60 * 1000);
}

// ─────────────────────────────────────────────
// グレースフルシャットダウン
// ─────────────────────────────────────────────
function shutdown(sig = "SIGTERM") {
  console.log(`[${jpNow()}] received ${sig}, shutting down...`);
  if (isRunning(monitorChild)) {
    try { monitorChild.kill("SIGTERM"); } catch {}
  }
  if (isRunning(discoverChild)) {
    try { discoverChild.kill("SIGTERM"); } catch {}
  }
  // 少し待ってから終了
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
