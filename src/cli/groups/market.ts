import type { Command } from "commander";
import * as market from "../../commands/market.js";
import { contextFrom, globalsFor, outOf } from "../globals.js";
import type { Writer } from "../output.js";

function parseTimestamp(v: string): number {
  if (/^\d+$/.test(v)) return Number(v);
  return Date.parse(v);
}

export function registerMarket(program: Command, write?: Writer): void {
  const mkt = program.command("market").description("public market data; requires no credentials");

  mkt.command("mids").argument("[symbols...]", "symbols to filter; omit for all").action(async (symbols: string[], _o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await market.midsCmd(contextFrom(p), symbols, outOf(p, write));
  });

  mkt
    .command("list")
    .description("list perpetual markets, or spot pairs with --spot")
    .option("--spot", "list spot pairs instead of perps", false)
    .option("--limit <n>", "limit rows")
    .action(async (opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as { spot: boolean; limit?: string };
      process.exitCode = await market.listCmd(
        contextFrom(p),
        { spot: o.spot === true, limit: o.limit === undefined ? undefined : Number(o.limit) },
        outOf(p, write),
      );
    });

  mkt.command("ticker").argument("<symbol>").action(async (symbol, _o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await market.tickerCmd(contextFrom(p), symbol, outOf(p, write));
  });

  mkt
    .command("candles")
    .argument("<symbol>")
    .option("--interval <i>", "candle interval (1m..1M)", "1h")
    .option("--start <t>", "start time: ISO 8601 or epoch milliseconds", parseTimestamp)
    .option("--end <t>", "end time: ISO 8601 or epoch milliseconds", parseTimestamp)
    .option("--limit <n>", "return at most the newest n candles")
    .action(async (symbol, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as { interval: string; start?: number; end?: number; limit?: string };
      const end = o.end ?? Date.now();
      const start = o.start ?? end - 7 * 86_400_000;
      process.exitCode = await market.candlesCmd(
        contextFrom(p),
        symbol,
        { interval: o.interval, startTime: start, endTime: end, limit: o.limit === undefined ? undefined : Number(o.limit) },
        outOf(p, write),
      );
    });

  mkt.command("trades").argument("<symbol>").action(async (symbol, _o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await market.tradesCmd(contextFrom(p), symbol, outOf(p, write));
  });

  mkt.command("book").argument("<symbol>").action(async (symbol, _o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await market.bookCmd(contextFrom(p), symbol, outOf(p, write));
  });

  mkt.command("funding").description("predicted funding per venue (multi-venue)").action(async (_o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await market.fundingCmd(contextFrom(p), outOf(p, write));
  });

  mkt.command("status").action(async (_o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await market.statusCmd(contextFrom(p), outOf(p, write));
  });
}
