#!/usr/bin/env node
/**
 * Re-capture the offline test fixtures from the live public read API.
 *
 * Fixtures let the offline suite assert against real production shapes instead
 * of shapes we invented. Run this when the API is expected to have changed,
 * then review the diff before committing: an unexpected shape change is a
 * signal, not noise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAINNET = "https://api.hyperliquid.xyz/info";

const REQUESTS = {
  "meta.json": { type: "meta" },
  "allMids.json": { type: "allMids" },
  "spotMeta.json": { type: "spotMeta" },
  "metaAndAssetCtxs.json": { type: "metaAndAssetCtxs" },
  "predictedFundings.json": { type: "predictedFundings" },
  "recentTrades.json": { type: "recentTrades", coin: "BTC" },
  "exchangeStatus.json": { type: "exchangeStatus" },
};

const outDir = join(import.meta.dirname, "..", "fixtures");
mkdirSync(outDir, { recursive: true });

for (const [file, body] of Object.entries(REQUESTS)) {
  const res = await fetch(MAINNET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`FAIL ${file}: HTTP ${res.status} ${text.slice(0, 120)}`);
    process.exitCode = 1;
    continue;
  }
  try {
    JSON.parse(text);
  } catch {
    console.error(`FAIL ${file}: response was not JSON`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(join(outDir, file), text);
  console.log(`ok ${file} (${text.length} bytes)`);
}
