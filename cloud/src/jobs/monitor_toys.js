// src/jobs/monitor_toys.js
import { runProfile, ts } from "./lib/core.js";

const FINDER_PER_PAGE = Number(process.env.FINDER_PER_PAGE || 100);

const QUERY_13299531 = {
  current_SALES_gte: 1,
  current_SALES_lte: 10000,
  rootCategory: ["13299531"],
  deltaPercent7_BUY_BOX_SHIPPING_gte: -1000,
  deltaPercent7_BUY_BOX_SHIPPING_lte: -15,
  buyBoxStatsAmazon365_gte: 1,
  buyBoxStatsAmazon365_lte: 100,
  current_AMAZON_gte: -1,
  current_AMAZON_lte: -1,
  current_NEW_gte: 1000,
  sort: [
    ["current_SALES", "asc"],
    ["monthlySold", "desc"]
  ],
  productType: [0, 1, 2],
  perPage: FINDER_PER_PAGE,
  page: 0
};

const tag  = ":teddy_bear: 13299531";
const root = 13299531;
const buildQuery = (page=0)=>({ ...QUERY_13299531, page });

console.log(ts(), "monitor_toys START");
runProfile({ tag, root, buildQuery, limit: 10 }).catch(e=> {
  console.error("FATAL monitor_toys:", e?.message || e);
  process.exit(1);
});
