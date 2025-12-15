import dotenv from "dotenv";
dotenv.config();

const num = (v, def) => (v === undefined ? def : Number(v));

export const cfg = {
  keepaKey: process.env.KEEPA_API_KEY,
  keepaDomain: num(process.env.KEEPA_DOMAIN, 5),
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  priceJumpPct: num(process.env.PRICE_JUMP_PCT, 5),
  checkIntervalMin: num(process.env.CHECK_INTERVAL_MIN, 10),
  cooldownHours: num(process.env.COOLDOWN_HOURS, 24),
  autoDiscovery: (process.env.AUTO_DISCOVERY || "off").toLowerCase() === "on",
  discoveryIntervalMin: num(process.env.DISCOVERY_INTERVAL_MIN, 60),
};

if (!cfg.keepaKey) throw new Error("KEEPA_API_KEY が未設定です");
if (!cfg.slackWebhookUrl) console.warn("Slack Webhook 未設定：投稿はスキップされます");
