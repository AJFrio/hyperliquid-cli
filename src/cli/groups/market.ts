import type { Command } from "commander";
import * as market from "../../commands/market.js";
import { UsageError } from "../../errors.js";
import { contextFrom, globalsFor, outOf } from "../globals.js";
import type { Writer } from "../output.js";

function parseTimestamp(v: string): number {
  if (/^\d+$/.test(v)) return Number(v);
  return Date.parse(v);
}

function addPageOptions(command: Command): Command {
  return command
    .option("--page <n>", "1-based page number", (value: string) => Number(value))
    .option("--limit <n>", "rows per page (1-100)", (value: string) => Number(value))
    .option("--all", "return all rows in the source response", false);
}

type PageCli = { page?: number; limit?: number; all?: boolean };

export function registerMarket(program: Command, write?: Writer): void {
  const mkt = program.command("market").description("public market data; requires no credentials");

  addPageOptions(
    mkt.command("mids").argument("[symbols...]", "symbols to filter; omit for all"),
  ).action(async (symbols: string[], opts: PageCli, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await market.midsCmd(
      contextFrom(p),
      symbols,
      {
        page: opts.page,
        limit: opts.limit,
        all: opts.all,
      },
      outOf(p, write),
    );
  });

  addPageOptions(
    mkt
      .command("list")
      .description("list perp markets or spot pairs with live context")
      .option("--spot", "list spot pairs instead of perps", false)
      .option("--dex <name>", "perp DEX name, or all")
      .option("--sort <field>", "volume, symbol, or index", "volume")
      .option("--search <text>", "match symbol, market label, or DEX name")
      .option("--include-delisted", "include delisted perps", false),
  ).action(async (opts, cmd: Command) => {
    const p = globalsFor(cmd);
    const o = opts as PageCli & {
      spot?: boolean;
      dex?: string;
      sort?: string;
      search?: string;
      includeDelisted?: boolean;
    };
    if (o.sort !== "volume" && o.sort !== "symbol" && o.sort !== "index") {
      throw new UsageError("USAGE", "--sort must be volume, symbol, or index");
    }
    process.exitCode = await market.listCmd(
      contextFrom(p),
      {
        spot: o.spot === true,
        dex: o.dex,
        sort: o.sort,
        search: o.search,
        includeDelisted: o.includeDelisted === true,
        page: o.page,
        limit: o.limit,
        all: o.all,
      },
      outOf(p, write),
    );
  });

  mkt
    .command("dexs")
    .description("list the primary and builder-deployed perpetual DEXs")
    .action(async (_opts, cmd: Command) => {
      const p = globalsFor(cmd);
      process.exitCode = await market.dexsCmd(contextFrom(p), outOf(p, write));
    });

  mkt
    .command("ticker")
    .argument("<symbol>")
    .action(async (symbol, _o, cmd: Command) => {
      const p = globalsFor(cmd);
      process.exitCode = await market.tickerCmd(contextFrom(p), symbol, outOf(p, write));
    });

  addPageOptions(
    mkt
      .command("candles")
      .argument("<symbol>")
      .option("--interval <i>", "candle interval (1m..1M)", "1h")
      .option("--start <t>", "start time: ISO 8601 or epoch milliseconds", parseTimestamp)
      .option("--end <t>", "end time: ISO 8601 or epoch milliseconds", parseTimestamp),
  ).action(async (symbol, opts, cmd: Command) => {
    const p = globalsFor(cmd);
    const o = opts as PageCli & { interval: string; start?: number; end?: number };
    const end = o.end ?? Date.now();
    const start = o.start ?? end - 7 * 86_400_000;
    process.exitCode = await market.candlesCmd(
      contextFrom(p),
      symbol,
      {
        interval: o.interval,
        startTime: start,
        endTime: end,
        page: o.page,
        limit: o.limit,
        all: o.all,
      },
      outOf(p, write),
    );
  });

  addPageOptions(mkt.command("trades").argument("<symbol>")).action(
    async (symbol, opts: PageCli, cmd: Command) => {
      const p = globalsFor(cmd);
      process.exitCode = await market.tradesCmd(
        contextFrom(p),
        symbol,
        {
          page: opts.page,
          limit: opts.limit,
          all: opts.all,
        },
        outOf(p, write),
      );
    },
  );

  mkt
    .command("book")
    .argument("<symbol>")
    .option("--depth <n>", "levels per side (1-20)", (value: string) => Number(value))
    .option("--all", "show all levels returned by the exchange", false)
    .action(async (symbol, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as { depth?: number; all?: boolean };
      process.exitCode = await market.bookCmd(
        contextFrom(p),
        symbol,
        { depth: o.depth, all: o.all },
        outOf(p, write),
      );
    });

  addPageOptions(
    mkt
      .command("funding")
      .description("predicted funding per venue (multi-venue)")
      .option("--symbol <symbol>", "filter to one perpetual market")
      .option("--venue <name>", "filter to one venue"),
  ).action(async (opts, cmd: Command) => {
    const p = globalsFor(cmd);
    const o = opts as PageCli & { symbol?: string; venue?: string };
    process.exitCode = await market.fundingCmd(
      contextFrom(p),
      {
        symbol: o.symbol,
        venue: o.venue,
        page: o.page,
        limit: o.limit,
        all: o.all,
      },
      outOf(p, write),
    );
  });

  mkt.command("status").action(async (_o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await market.statusCmd(contextFrom(p), outOf(p, write));
  });
}
