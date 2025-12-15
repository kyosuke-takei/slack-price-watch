slack-price-watch/
├─ .env                # 本番は.envに秘密情報（gitに上げない）
├─ .env.example        # 共有用のダミー値
├─ .gitignore
├─ package.json
├─ README.md
├─ data/
│  ├─ watchlist.json   # 監視ASINリスト（手動/自動で増える）
│  └─ seeds.json       # 自動取得の種（キーワード/ブランド等）
├─ logs/
│  └─ .gitkeep         # ログ出力先
├─ src/
│  ├─ index.js         # エントリ（単発実行 or ジョブ起動）
│  ├─ config/
│  │  └─ index.js      # 設定読込（env/デフォルト/バリデーション）
│  ├─ jobs/
│  │  ├─ monitor.js    # 価格↑/在庫切れを検知→Slack投稿
│  │  └─ discover.js   # Keepaで候補探索→watchlistに自動追加
│  ├─ services/
│  │  ├─ keepa.js      # Keepa API呼び出し（search/query/product）
│  │  └─ slack.js      # Slack投稿（Webhook/Bot Token切替可能）
│  ├─ storage/
│  │  ├─ state.js      # 前回値・クールダウン等の保存/読込
│  │  └─ watchlist.js  # 監視リストの読込/重複排除/追加
│  └─ utils/
│     └─ logger.js     # ロガー（時間/レベル付き出力）
└─ test/               # あればユニットテスト


基本

Slack疎通テスト:
npm run ping

書籍のASIN収集（明日〜7日・Amazon本体なし）:
npm run discover

一致結果をSlack通知（monitor単発）:
npm run monitor

定期実行ランナー（intervalで回す）:
npm start

“実結果だけ通知”で静かに実行（おすすめ）

（ハートビート/テスト通知をオフ）

PowerShell:

$env:HEARTBEAT="0"; $env:ALWAYS_ALERT_FIRST_N="0"; npm run monitor


コマンドプロンプト(cmd):

set HEARTBEAT=0 && set ALWAYS_ALERT_FIRST_N=0 && npm run monitor