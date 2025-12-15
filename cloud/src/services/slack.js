// src/services/slack.js
// Slack Incoming Webhook 送信用ラッパー（fetch版）

import "dotenv/config";

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!WEBHOOK_URL) {
  throw new Error("SLACK_WEBHOOK_URL is required");
}

/**
 * Slack Incoming Webhook へ投稿
 * @param {{ text?: string, blocks?: any[] }} payload
 */
export async function slack(payload) {
  const safePayload = {
    text: payload.text || "[slack-price-watch] notification",
    ...payload,
  };

  let res;
  try {
    res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(safePayload),
    });
  } catch (err) {
    console.error("Slack fetch error:", err);
    throw err;
  }

  const body = await res.text().catch(() => "");

  if (!res.ok) {
    console.error(
      "Slack error",
      res.status,
      res.statusText,
      body.slice(0, 500).replace(/\s+/g, " ")
    );
    console.error(
      "Payload snippet:",
      JSON.stringify(safePayload).slice(0, 300)
    );
    throw new Error(`Slack ${res.status} ${res.statusText}`);
  }

  return body;
}
