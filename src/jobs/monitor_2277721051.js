// src/jobs/monitor_2277721051.js
import { runProfile, ts } from "./lib/core.js";

const FINDER_PER_PAGE = Number(process.env.FINDER_PER_PAGE || 100);

const QUERY_2277721051 = {
  current_SALES_gte: 1,
  current_SALES_lte: 10000,
  current_AMAZON_gte: -1,
  current_AMAZON_lte: -1,
  rootCategory: ["2277721051"],
  buyBoxStatsAmazon365_gte: 1,
  buyBoxStatsAmazon365_lte: 100,
  deltaPercent7_NEW_gte: -1000,
  deltaPercent7_NEW_lte: -15,
  current_NEW_gte: 1000,
  sort: [
    ["current_SALES", "asc"],
    ["monthlySold", "desc"]
  ],
  productType: [0, 1, 2],
  perPage: FINDER_PER_PAGE,
  page: 0
};

const tag  = ":books: 2277721051";
const root = 2277721051;
const buildQuery = (page=0)=>({ ...QUERY_2277721051, page });

console.log(ts(), "monitor_2277721051 START");
runProfile({ tag, root, buildQuery, limit: 10 }).catch(e=> {
  console.error("FATAL monitor_2277721051:", e?.message || e);
  process.exit(1);
});
