// ESM版
import 'dotenv/config'; // ← これで .env を読み込む（副作用import）

const url = process.env.SLACK_WEBHOOK_URL;
if (!url) {
  console.error('SLACK_WEBHOOK_URL is missing');
  process.exit(1);
}

const payload = { text: '✅ ping (ESM)' };

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  console.log('ok', res.status);
} catch (e) {
  console.error('ng', e.message);
  process.exit(1);
}
