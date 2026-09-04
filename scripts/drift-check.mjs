// Weekly drift check.
//
// The daily job runs a *replica* of the screener (config/screener.json).
// If the saved screener is edited in TradingView, that replica silently
// diverges and the dataset quietly becomes two incompatible halves.
//
// This loads the real saved screener in a browser and compares its symbol
// set against the API replica. Exit code 1 => drift, and the workflow
// raises an issue. It writes drift-report.md either way.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadConfig, fetchScreener, ROOT } from './screener.mjs';

const cfg = loadConfig();

async function scrapeSavedScreener() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  try {
    await page.goto(cfg.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-rowkey]', { timeout: 45000 });

    // The table is virtualised: scroll until the row count stops growing,
    // otherwise we compare against a truncated list and report false drift.
    let prev = -1, stable = 0;
    for (let i = 0; i < 40 && stable < 3; i++) {
      const n = await page.locator('[data-rowkey]').count();
      stable = n === prev ? stable + 1 : 0;
      prev = n;
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(600);
    }

    return await page.$$eval('[data-rowkey]', (els) =>
      [...new Set(els.map((e) => e.getAttribute('data-rowkey')))]
    );
  } finally {
    await browser.close();
  }
}

const [{ rows: apiRows }, scraped] = await Promise.all([fetchScreener(cfg), scrapeSavedScreener()]);

const apiSet = new Set(apiRows.map((r) => r.ticker));
const uiSet = new Set(scraped);
const onlyApi = [...apiSet].filter((t) => !uiSet.has(t)).sort();
const onlyUi = [...uiSet].filter((t) => !apiSet.has(t)).sort();
const drift = onlyApi.length > 0 || onlyUi.length > 0;

const lines = [
  `# Screener drift check`,
  ``,
  `- Checked: ${new Date().toISOString()}`,
  `- Saved screener: ${cfg.sourceUrl}`,
  `- API replica matched **${apiSet.size}** symbols`,
  `- Live screener showed **${uiSet.size}** symbols`,
  ``,
  drift ? `## Drift detected` : `## In sync`,
  ``,
];

if (drift) {
  lines.push(
    `The replica in \`config/screener.json\` no longer reproduces the saved screener.`,
    `This usually means the screener was edited in TradingView. Until the config is`,
    `updated, the daily capture is recording a **different screen** from the one you see.`,
    ``,
    onlyApi.length ? `**In API replica but not live UI (${onlyApi.length}):**\n${onlyApi.map((s) => `- \`${s}\``).join('\n')}\n` : '',
    onlyUi.length ? `**In live UI but not API replica (${onlyUi.length}):**\n${onlyUi.map((s) => `- \`${s}\``).join('\n')}\n` : '',
    `### Fix`,
    `Open the screener, read the filter chips, and update \`config/screener.json\` to match.`,
  );
} else {
  lines.push(`Both routes returned the same ${apiSet.size} symbols. No action needed.`);
}

writeFileSync(join(ROOT, 'drift-report.md'), lines.filter(Boolean).join('\n') + '\n');
console.log(drift ? `DRIFT: +${onlyUi.length} / -${onlyApi.length}` : `in sync (${apiSet.size} symbols)`);
process.exitCode = drift ? 1 : 0;
