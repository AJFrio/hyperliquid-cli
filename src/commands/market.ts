import {
  getAllMids,
  getCandles,
  getExchangeStatus,
  getL2Book,
  getMetaAndCtx,
  getPredictedFundings,
  getRecentTrades,
  getSpotMeta,
} from "../api/info.js";
import type { Context } from "../cli/context.js";
import { emitSuccess, type OutputOptions, renderTable } from "../cli/output.js";
import { ApiError, UsageError } from "../errors.js";

const VALID_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
] as const;

export async function midsCmd(
  ctx: Context,
  symbols: string[],
  out: OutputOptions,
): Promise<number> {
  const all = await getAllMids(ctx.infoOpts);
  if (symbols.length === 0) {
    emitSuccess({ mids: all }, out, () =>
      renderTable(Object.entries(all).map(([coin, px]) => ({ coin, px }))),
    );
    return 0;
  }
  const resolver = await ctx.assets();
  const picked: Record<string, string> = {};
  for (const sym of symbols) {
    const asset = resolver.resolveAny(sym);
    const key = asset.kind === "spot" ? asset.symbol : asset.symbol;
    const mid = all[key] ?? all[`#${asset.assetId}`];
    if (mid === undefined) {
      throw new ApiError(`no mid price returned for ${sym} (resolved to ${key})`, {
        symbol: sym,
        key,
      });
    }
    picked[key] = mid;
  }
  emitSuccess(picked, out, () =>
    renderTable(Object.entries(picked).map(([coin, px]) => ({ coin, px }))),
  );
  return 0;
}

export async function listCmd(
  ctx: Context,
  opts: { spot: boolean; limit: number | undefined },
  out: OutputOptions,
): Promise<number> {
  if (opts.spot) {
    const spot = await getSpotMeta(ctx.infoOpts);
    const rows = spot.universe.slice(0, opts.limit ?? spot.universe.length).map((p) => ({
      pair: p.name,
      index: p.index,
      base: p.tokens[0],
      quote: p.tokens[1],
      canonical: p.isCanonical ?? false,
    }));
    emitSuccess({ count: rows.length, pairs: rows }, out, () =>
      renderTable(rows, ["pair", "index", "base", "quote"]),
    );
    return 0;
  }
  const [meta] = await getMetaAndCtx(ctx.infoOpts);
  const { universe } = meta;
  const rows = universe
    .map((a, i) => ({
      symbol: a.name,
      index: i,
      szDecimals: a.szDecimals,
      maxLeverage: a.maxLeverage,
    }))
    .slice(0, opts.limit ?? universe.length);
  emitSuccess({ count: rows.length, markets: rows }, out, () =>
    renderTable(rows, ["index", "symbol", "szDecimals", "maxLeverage"]),
  );
  return 0;
}

export async function tickerCmd(ctx: Context, symbol: string, out: OutputOptions): Promise<number> {
  const [meta, ctxs] = await getMetaAndCtx(ctx.infoOpts);
  const index = meta.universe.findIndex((a) => a.name === symbol.toUpperCase());
  if (index === -1) {
    const spot = await getSpotMeta(ctx.infoOpts);
    if (!spot.universe.some((p) => p.name === symbol)) {
      throw new UsageError("UNKNOWN_ASSET", `unknown perpetual market: ${symbol}`, { symbol });
    }
    const mids = await getAllMids(ctx.infoOpts);
    const mid = mids[symbol];
    emitSuccess({ symbol, kind: "spot", midPx: mid ?? null }, out);
    return 0;
  }
  const asset = meta.universe[index];
  const context = ctxs[index];
  if (asset === undefined || context === undefined) {
    throw new ApiError(`no market context returned for ${symbol}`, { symbol });
  }
  emitSuccess(
    {
      symbol: asset.name,
      kind: "perp",
      index,
      szDecimals: asset.szDecimals,
      maxLeverage: asset.maxLeverage,
      ...context,
    },
    out,
    (v) => renderTable([v as Record<string, unknown>]),
  );
  return 0;
}

/**
 * Candles are capped (~5000) and history is pruned, so a wide window can come
 * back short or empty with HTTP 200. We always report the window we asked for
 * alongside what we got, and flag truncation rather than under-deliver silently.
 */
export async function candlesCmd(
  ctx: Context,
  symbol: string,
  opts: { interval: string; startTime: number; endTime: number; limit: number | undefined },
  out: OutputOptions,
): Promise<number> {
  if (!VALID_INTERVALS.includes(opts.interval as (typeof VALID_INTERVALS)[number])) {
    throw new UsageError(
      "USAGE",
      `invalid interval ${opts.interval}; expected one of ${VALID_INTERVALS.join(", ")}`,
      {
        interval: opts.interval,
      },
    );
  }
  const start = requireTimestamp(opts.startTime, "--start");
  const end = requireTimestamp(opts.endTime, "--end");
  if (end <= start) {
    throw new UsageError("USAGE", "--start must be before --end", {
      startTime: start,
      endTime: end,
    });
  }
  const rows = await getCandles(
    { coin: symbol.toUpperCase(), interval: opts.interval, startTime: start, endTime: end },
    ctx.infoOpts,
  );
  const limited = opts.limit === undefined ? rows : rows.slice(-opts.limit);
  const payload = {
    coin: symbol.toUpperCase(),
    interval: opts.interval,
    requested: { startTime: start, endTime: end },
    returned: limited.length,
    availableInWindow: rows.length,
    truncated: limited.length < rows.length,
    empty: limited.length === 0,
    note:
      limited.length === 0
        ? "no candles returned: the exchange prunes history and caps responses at ~5000 candles; widen --start/--end carefully"
        : undefined,
    candles: limited,
  };
  emitSuccess(payload, out, () => renderTable(limited, ["t", "o", "h", "l", "c", "v", "n"]));
  return 0;
}

/**
 * The API speaks epoch milliseconds, but humans and agents both reach for ISO
 * 8601. Accept either and fail loudly rather than sending NaN, which the server
 * answers with an opaque 422.
 */
function requireTimestamp(value: number, flag: string): number {
  if (!Number.isFinite(value)) {
    throw new UsageError("USAGE", `${flag} must be an ISO 8601 timestamp or epoch milliseconds`, {
      flag,
    });
  }
  return value;
}

export async function tradesCmd(ctx: Context, symbol: string, out: OutputOptions): Promise<number> {
  const rows = await getRecentTrades(symbol.toUpperCase(), ctx.infoOpts);
  emitSuccess({ coin: symbol.toUpperCase(), count: rows.length, trades: rows }, out, () =>
    renderTable(rows, ["time", "side", "px", "sz", "tid"]),
  );
  return 0;
}

export async function bookCmd(ctx: Context, symbol: string, out: OutputOptions): Promise<number> {
  const book = await getL2Book(symbol.toUpperCase(), ctx.infoOpts);
  emitSuccess(book, out, (v) => {
    const b = v as {
      coin: string;
      time: number;
      levels: [{ px: string; sz: string }[], { px: string; sz: string }[]];
    };
    const rows = [
      ...b.levels[0].map((l) => ({ side: "bid", px: l.px, sz: l.sz })),
      ...b.levels[1].map((l) => ({ side: "ask", px: l.px, sz: l.sz })),
    ];
    return renderTable(rows, ["side", "px", "sz"]);
  });
  return 0;
}

export async function fundingCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const raw = await getPredictedFundings(ctx.infoOpts);
  const rows = raw.map(([coin, venues]) => ({
    coin,
    venues: venues.map(([venue, f]) => ({
      venue,
      fundingRate: f?.fundingRate ?? null,
      nextFundingTime: f?.nextFundingTime ?? null,
      fundingIntervalHours: f?.fundingIntervalHours ?? null,
      available: f !== null,
    })),
  }));
  emitSuccess({ count: rows.length, funding: rows }, out, () =>
    renderTable(
      rows.flatMap((r) => r.venues.map((v) => ({ coin: r.coin, ...v }))),
      ["coin", "venue", "fundingRate", "fundingIntervalHours"],
    ),
  );
  return 0;
}

export async function statusCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const status = await getExchangeStatus(ctx.infoOpts);
  emitSuccess({ network: ctx.flags.testnet ? "testnet" : "mainnet", ...status }, out, (v) =>
    renderTable([v as Record<string, unknown>]),
  );
  return 0;
}
