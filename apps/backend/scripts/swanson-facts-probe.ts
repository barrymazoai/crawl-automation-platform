/** 直接测浏览器通道抠成分表这一步，不走流水线。 */
import { startChromeLane } from "@crawl-automation/runtime";
import { createSwansonFetcher } from "../src/swanson/fetcher.js";
import { egressEnv, loadEnv } from "../src/workers/shared/env.js";

async function main() {
  const env = loadEnv(egressEnv);
  const browser = await startChromeLane({ id: 7, profileRoot: `${env.SALES_CHANNEL_EGRESS_PROFILE_ROOT}/probe`, headless: false });
  process.env.CHROME_CDP_URL = browser.cdpUrl;
  const fetcher = createSwansonFetcher();
  const signal = new AbortController().signal;
  try {
    for (const url of process.argv.slice(2)) {
      console.log(`\n──── ${url} ────`);
      const facts = await fetcher.facts(url, signal);
      console.log(`  成分表: ${facts ? `有，${facts.length} 字符` : "null"}`);
      if (facts) console.log(`  ${facts.slice(0, 300).replace(/\n/g, " ")}`);
      // 顺带看看页面里到底有没有那个字段
      const probe = await fetcher.text(url, signal);
      const idx = probe.search(/supplementFacts/i);
      console.log(`  取回正文 ${probe.length} 字符 · supplementFacts 位置 ${idx}`);
      if (idx >= 0) console.log(`  周边: ${probe.slice(idx, idx + 160).replace(/\n/g, " ")}`);
    }
  } finally { await fetcher.close(); await browser.close?.().catch(() => {}); }
}
main().catch((error) => { console.error("失败:", error.message); process.exit(1); });
