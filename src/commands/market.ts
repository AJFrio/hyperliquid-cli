import {
  getCandles,
  getExchangeStatus,
  getL2Book,
  getMetaAndCtx,
  getPredictedFundings,
  getRecentTrades,
  getSpotMetaAndCtx,
  type PerpContext,
  type SpotContext,
} from "../api/info.js";
import type { Context } from "../cli/context.js";
import {
  emitSuccess,
  type OutputOptions,
  type PageRequest,
  pageRows,
  renderTable,
} from "../cli/output.js";
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

export interface MarketPageOptions extends PageRequest {
  spot?: boolean;
  search?: string | undefined;
  sort?: "volume" | "symbol" | "index" | undefined;
  includeDelisted?: boolean;
  dex?: string | undefined;
}

type Row = Record<string, unknown>;
type PerpDexRef = { name: string; fullName?: string; index: number };

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = new Array(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        const value = values[index];
        if (value !== undefined) result[index] = await fn(value);
      }
    }),
  );
  return result;
}

function decimalParts(value: unknown): { coefficient: bigint; scale: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) return undefined;
  const fraction = match[3] ?? "";
  const sign = match[1] === "-" ? -1n : 1n;
  return { coefficient: sign * BigInt(`${match[2]}${fraction}`), scale: fraction.length };
}

function compareDecimalDesc(left: unknown, right: unknown): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  const scale = Math.max(a.scale, b.scale);
  const av = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bv = b.coefficient * 10n ** BigInt(scale - b.scale);
  return av === bv ? 0 : av > bv ? -1 : 1;
}

function compareText(left: unknown, right: unknown): number {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function sortMarkets(rows: Row[], sort: MarketPageOptions["sort"]): Row[] {
  return [...rows].sort((a, b) => {
    if (sort === "index")
      return (
        Number(a.dexIndex ?? 0) - Number(b.dexIndex ?? 0) ||
        Number(a.index ?? 0) - Number(b.index ?? 0)
      );
    if (sort === "symbol") return compareText(a.symbol ?? a.pair, b.symbol ?? b.pair);
    return (
      compareDecimalDesc(a.dayNtlVlm, b.dayNtlVlm) ||
      compareText(a.symbol ?? a.pair, b.symbol ?? b.pair)
    );
  });
}

async function selectedDexes(ctx: Context, requested?: string): Promise<PerpDexRef[]> {
  if (requested === undefined) return [{ name: "", fullName: "Hyperliquid", index: 0 }];
  const dexes = await ctx.perpDexes();
  if (requested.toLowerCase() === "all") {
    return dexes.map((dex, index) => ({
      name: dex?.name ?? "",
      fullName: dex?.fullName ?? "Hyperliquid",
      index,
    }));
  }
  const name = await ctx.resolveDexName(requested);
  const index = name === "" ? 0 : dexes.findIndex((dex) => dex?.name === name);
  const dex = dexes[index];
  return [{ name: dex?.name ?? "", fullName: dex?.fullName ?? "Hyperliquid", index }];
}

async function perpRows(ctx: Context, opts: MarketPageOptions, out: OutputOptions): Promise<Row[]> {
  const dexs = await selectedDexes(ctx, opts.dex);
  const byDex = await mapConcurrent(dexs, 3, async (dex) => {
    const [meta, contexts] = await getMetaAndCtx(ctx.infoOpts, dex.name || undefined);
    return meta.universe.map((asset, index): Row => {
      const context = contexts[index];
      if (context === undefined)
        throw new ApiError(`no market context returned for ${asset.name}`, {
          symbol: asset.name,
          dex: dex.name,
        });
      const row: Row = {
        symbol: asset.name,
        market: `${asset.name} perpetual`,
        kind: dex.index === 0 ? "perp" : "hip3",
        dex: dex.name || "primary",
        dexName: dex.fullName,
        dexIndex: dex.index,
        index,
        isDelisted: asset.isDelisted === true,
        szDecimals: asset.szDecimals,
        maxLeverage: asset.maxLeverage,
        midPx: context.midPx ?? null,
        markPx: context.markPx ?? null,
        prevDayPx: context.prevDayPx ?? null,
        dayNtlVlm: context.dayNtlVlm ?? null,
        funding: context.funding ?? null,
        openInterest: context.openInterest ?? null,
      };
      if (out.full) row.raw = { asset, context };
      return row;
    });
  });
  return byDex.flat().filter((row) => opts.includeDelisted === true || row.isDelisted !== true);
}

async function spotRows(ctx: Context, out: OutputOptions): Promise<Row[]> {
  const [meta, contexts] = await getSpotMetaAndCtx(ctx.infoOpts);
  const tokens = new Map(meta.tokens.map((token) => [token.index, token]));
  const contextByCoin = new Map(contexts.map((context) => [context.coin, context]));
  return meta.universe.map((pair): Row => {
    const base = tokens.get(pair.tokens[0]);
    const quote = tokens.get(pair.tokens[1]);
    const displayPair =
      base !== undefined && quote !== undefined ? `${base.name}/${quote.name}` : pair.name;
    const context = contextByCoin.get(pair.name);
    const row: Row = {
      symbol: pair.name,
      pair: displayPair,
      market: base?.fullName ? `${base.fullName} (${displayPair})` : displayPair,
      fullName: base?.fullName ?? null,
      kind: "spot",
      index: pair.index,
      base: base?.name ?? null,
      quote: quote?.name ?? null,
      canonical: pair.isCanonical ?? false,
      midPx: context?.midPx ?? null,
      markPx: context?.markPx ?? null,
      prevDayPx: context?.prevDayPx ?? null,
      dayNtlVlm: context?.dayNtlVlm ?? null,
      szDecimals: base?.szDecimals ?? null,
    };
    if (out.full) row.raw = { pair, baseToken: base, quoteToken: quote, context };
    return row;
  });
}

function applySearch(rows: Row[], search?: string): Row[] {
  if (search === undefined || search.trim() === "") return rows;
  const needle = search.trim().toLowerCase();
  return rows.filter((row) =>
    [row.symbol, row.pair, row.market, row.fullName, row.dex, row.dexName].some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(needle),
    ),
  );
}

function pagePayload(
  rows: Row[],
  request: PageRequest,
  options: { total?: number | null; sourceLimited?: boolean; newestFirst?: boolean } = {},
) {
  const result = pageRows(rows, request, options);
  return {
    count: result.rows.length,
    total: result.page.total,
    page: result.page,
    rows: result.rows,
  };
}

export async function midsCmd(
  ctx: Context,
  symbols: string[],
  request: PageRequest,
  out: OutputOptions,
): Promise<number> {
  if (symbols.length === 0) {
    const [perps, spots] = await Promise.all([perpRows(ctx, {}, out), spotRows(ctx, out)]);
    const rows = sortMarkets([...perps, ...spots], "volume").map((row) => ({
      symbol: row.symbol,
      market: row.market,
      kind: row.kind,
      dex: row.dex,
      midPx: row.midPx,
    }));
    const page = pagePayload(rows, request, { total: rows.length });
    emitSuccess(
      { count: page.count, total: page.total, page: page.page, mids: page.rows },
      out,
      () => renderTable(page.rows, ["symbol", "market", "kind", "midPx"]),
    );
    return 0;
  }

  const assets = await Promise.all(symbols.map((symbol) => ctx.resolveAny(symbol)));
  const uniqueDexes = [
    ...new Set(assets.filter((asset) => asset.kind !== "spot").map((asset) => asset.dex ?? "")),
  ];
  const dexQuotes = new Map<string, Map<string, PerpContext>>();
  await Promise.all(
    uniqueDexes.map(async (dex) => {
      const [meta, contexts] = await getMetaAndCtx(ctx.infoOpts, dex || undefined);
      dexQuotes.set(
        dex,
        new Map(
          meta.universe.map((asset, index) => [asset.name, contexts[index] ?? ({} as PerpContext)]),
        ),
      );
    }),
  );
  const spotAssets = assets.filter((asset) => asset.kind === "spot");
  let spotQuotes = new Map<string, SpotContext>();
  if (spotAssets.length > 0) {
    const [meta, contexts] = await getSpotMetaAndCtx(ctx.infoOpts);
    const pairNameBySymbol = new Map(meta.universe.map((pair) => [pair.name, pair.name]));
    spotQuotes = new Map(contexts.map((context) => [context.coin, context]));
    for (const asset of spotAssets) {
      if (!pairNameBySymbol.has(asset.symbol)) spotQuotes.delete(asset.symbol);
    }
  }
  const rows = assets.map((asset): Row => {
    const context =
      asset.kind === "spot"
        ? spotQuotes.get(asset.symbol)
        : dexQuotes.get(asset.kind === "hip3" ? (asset.dex ?? "") : "")?.get(asset.symbol);
    const midPx = context?.midPx ?? null;
    return {
      symbol: asset.symbol,
      market: asset.displayName ?? asset.symbol,
      kind: asset.kind,
      ...(asset.dex === undefined ? {} : { dex: asset.dex }),
      midPx,
    };
  });
  const paged = pageRows(rows, request, { total: rows.length });
  if (request.page === undefined && request.limit === undefined && request.all !== true) {
    const picked: Record<string, string | null> = {};
    for (const row of rows) {
      picked[String(row.symbol)] = typeof row.midPx === "string" ? row.midPx : null;
    }
    emitSuccess(picked, out, () =>
      renderTable(Object.entries(picked).map(([coin, px]) => ({ coin, px }))),
    );
  } else {
    emitSuccess(
      { count: paged.rows.length, total: rows.length, page: paged.page, mids: paged.rows },
      out,
      () => renderTable(paged.rows, ["symbol", "market", "kind", "midPx"]),
    );
  }
  return 0;
}

export async function listCmd(
  ctx: Context,
  opts: MarketPageOptions,
  out: OutputOptions,
): Promise<number> {
  if (opts.spot && opts.dex !== undefined)
    throw new UsageError("USAGE", "--dex cannot be combined with --spot");
  const source = opts.spot ? await spotRows(ctx, out) : await perpRows(ctx, opts, out);
  const matches = applySearch(source, opts.search);
  const rows = sortMarkets(matches, opts.sort ?? "volume");
  const paged = pageRows(rows, opts, { total: rows.length });
  const key = opts.spot ? "pairs" : "markets";
  emitSuccess(
    { count: paged.rows.length, total: rows.length, page: paged.page, [key]: paged.rows },
    out,
    () =>
      renderTable(
        paged.rows,
        opts.spot
          ? ["index", "symbol", "pair", "fullName", "midPx", "dayNtlVlm", "canonical"]
          : ["dex", "index", "symbol", "market", "midPx", "dayNtlVlm", "maxLeverage"],
      ),
  );
  return 0;
}

export async function dexsCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const dexs = await ctx.perpDexes();
  const rows = dexs.map((dex, index) => ({
    index,
    name: dex?.name ?? "primary",
    apiName: dex?.name ?? "",
    fullName: dex?.fullName ?? "Hyperliquid",
    kind: dex === null ? "primary" : "hip3",
  }));
  emitSuccess({ count: rows.length, dexs: rows }, out, () =>
    renderTable(rows, ["index", "name", "fullName", "kind"]),
  );
  return 0;
}

export async function tickerCmd(ctx: Context, symbol: string, out: OutputOptions): Promise<number> {
  const asset = await ctx.resolveAny(symbol);
  let row: Row;
  if (asset.kind === "spot") {
    const [meta, contexts] = await getSpotMetaAndCtx(ctx.infoOpts);
    const pair = meta.universe.find((candidate) => candidate.name === asset.symbol);
    const base =
      pair === undefined ? undefined : meta.tokens.find((token) => token.index === pair.tokens[0]);
    const quote =
      pair === undefined ? undefined : meta.tokens.find((token) => token.index === pair.tokens[1]);
    const context = contexts.find((candidate) => candidate.coin === asset.symbol);
    if (pair === undefined || context === undefined)
      throw new ApiError(`no market context returned for ${asset.symbol}`, {
        symbol: asset.symbol,
      });
    row = {
      symbol: asset.symbol,
      market: base?.fullName
        ? `${base.fullName} (${base.name}/${quote?.name ?? "?"})`
        : `${base?.name ?? asset.symbol}/${quote?.name ?? "?"}`,
      kind: "spot",
      index: pair.index,
      midPx: context.midPx ?? null,
      markPx: context.markPx ?? null,
      prevDayPx: context.prevDayPx ?? null,
      dayNtlVlm: context.dayNtlVlm ?? null,
      dayBaseVlm: context.dayBaseVlm ?? null,
    };
    if (out.full) row.raw = { pair, baseToken: base, quoteToken: quote, context };
  } else {
    const dex = asset.kind === "hip3" ? asset.dex : undefined;
    const [meta, contexts] = await getMetaAndCtx(ctx.infoOpts, dex);
    const index = meta.universe.findIndex(
      (candidate) => candidate.name.toUpperCase() === asset.symbol.toUpperCase(),
    );
    const market = meta.universe[index];
    const context = contexts[index];
    if (market === undefined || context === undefined)
      throw new ApiError(`no market context returned for ${asset.symbol}`, {
        symbol: asset.symbol,
      });
    row = {
      symbol: market.name,
      market: asset.dexFullName
        ? `${market.name} perpetual (${asset.dexFullName})`
        : `${market.name} perpetual`,
      kind: asset.kind,
      dex: dex ?? "primary",
      index,
      isDelisted: market.isDelisted === true,
      szDecimals: market.szDecimals,
      maxLeverage: market.maxLeverage,
      midPx: context.midPx ?? null,
      markPx: context.markPx ?? null,
      prevDayPx: context.prevDayPx ?? null,
      dayNtlVlm: context.dayNtlVlm ?? null,
      dayBaseVlm: context.dayBaseVlm ?? null,
      funding: context.funding ?? null,
      openInterest: context.openInterest ?? null,
      oraclePx: context.oraclePx ?? null,
    };
    if (out.full) row.raw = { asset: market, context };
  }
  emitSuccess(row, out, (value) => renderTable([value as Row]));
  return 0;
}

/** Candle responses have an exchange-side cap and may come back short or empty. */
export async function candlesCmd(
  ctx: Context,
  symbol: string,
  opts: { interval: string; startTime: number; endTime: number } & PageRequest,
  out: OutputOptions,
): Promise<number> {
  if (!VALID_INTERVALS.includes(opts.interval as (typeof VALID_INTERVALS)[number])) {
    throw new UsageError(
      "USAGE",
      `invalid interval ${opts.interval}; expected one of ${VALID_INTERVALS.join(", ")}`,
      { interval: opts.interval },
    );
  }
  const start = requireTimestamp(opts.startTime, "--start");
  const end = requireTimestamp(opts.endTime, "--end");
  if (end <= start)
    throw new UsageError("USAGE", "--start must be before --end", {
      startTime: start,
      endTime: end,
    });
  const asset = await ctx.resolveAny(symbol);
  const rows = await getCandles(
    { coin: asset.symbol, interval: opts.interval, startTime: start, endTime: end },
    ctx.infoOpts,
  );
  const sourceLimited = rows.length >= 5000;
  const paged = pageRows(rows, opts, {
    sourceLimited,
    total: sourceLimited ? null : rows.length,
    newestFirst: true,
  });
  const chronological = [...paged.rows].reverse();
  const candles = out.full
    ? chronological
    : chronological.map((candle) => ({
        t: candle.t,
        o: candle.o,
        h: candle.h,
        l: candle.l,
        c: candle.c,
        v: candle.v,
        n: candle.n,
      }));
  emitSuccess(
    {
      coin: asset.symbol,
      market: asset.displayName ?? asset.symbol,
      interval: opts.interval,
      requested: { startTime: start, endTime: end },
      returned: candles.length,
      availableInWindow: rows.length,
      truncated: paged.page.hasMore || sourceLimited,
      sourceLimited,
      page: paged.page,
      empty: candles.length === 0,
      note:
        candles.length === 0
          ? "no candles returned; exchange history is pruned and responses are capped, so adjust --start/--end"
          : undefined,
      candles,
    },
    out,
    () => renderTable(candles, ["t", "o", "h", "l", "c", "v", "n"]),
  );
  return 0;
}

function requireTimestamp(value: number, flag: string): number {
  if (!Number.isFinite(value)) {
    throw new UsageError("USAGE", `${flag} must be an ISO 8601 timestamp or epoch milliseconds`, {
      flag,
    });
  }
  return value;
}

export async function tradesCmd(
  ctx: Context,
  symbol: string,
  request: PageRequest,
  out: OutputOptions,
): Promise<number> {
  const asset = await ctx.resolveAny(symbol);
  const raw = await getRecentTrades(asset.symbol, ctx.infoOpts);
  const rows = [...raw].sort((a, b) => b.time - a.time);
  const sourceLimited = rows.length >= 2000;
  const paged = pageRows(rows, request, {
    total: sourceLimited ? null : rows.length,
    sourceLimited,
  });
  const trades = out.full
    ? paged.rows
    : paged.rows.map((trade) => ({
        time: trade.time,
        side: trade.side,
        px: trade.px,
        sz: trade.sz,
        tid: trade.tid,
      }));
  emitSuccess(
    {
      coin: asset.symbol,
      market: asset.displayName ?? asset.symbol,
      count: trades.length,
      total: paged.page.total,
      page: paged.page,
      trades,
    },
    out,
    () => renderTable(trades, ["time", "side", "px", "sz", "tid"]),
  );
  return 0;
}

export async function bookCmd(
  ctx: Context,
  symbol: string,
  opts: { depth?: number | undefined; all?: boolean | undefined },
  out: OutputOptions,
): Promise<number> {
  const depth = opts.all === true ? 20 : (opts.depth ?? 10);
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 20) {
    throw new UsageError("USAGE", "--depth must be an integer from 1 to 20", { depth });
  }
  if (opts.all === true && opts.depth !== undefined)
    throw new UsageError("USAGE", "--all cannot be combined with --depth");
  const asset = await ctx.resolveAny(symbol);
  const book = await getL2Book(asset.symbol, ctx.infoOpts);
  const levels = [book.levels[0].slice(0, depth), book.levels[1].slice(0, depth)];
  const bids = levels[0] ?? [];
  const asks = levels[1] ?? [];
  const payload = {
    coin: asset.symbol,
    market: asset.displayName ?? asset.symbol,
    time: book.time,
    depth,
    levels,
    ...(out.full ? { raw: book } : {}),
  };
  emitSuccess(payload, out, () =>
    renderTable(
      [
        ...bids.map((level) => ({ side: "bid", ...level })),
        ...asks.map((level) => ({ side: "ask", ...level })),
      ],
      ["side", "px", "sz", "n"],
    ),
  );
  return 0;
}

export async function fundingCmd(
  ctx: Context,
  request: PageRequest & { symbol?: string | undefined; venue?: string | undefined },
  out: OutputOptions,
): Promise<number> {
  const raw = await getPredictedFundings(ctx.infoOpts);
  const rows = raw
    .flatMap(([coin, venues]) =>
      venues.map(([venue, funding]) => ({
        coin,
        venue,
        fundingRate: funding?.fundingRate ?? null,
        nextFundingTime: funding?.nextFundingTime ?? null,
        fundingIntervalHours: funding?.fundingIntervalHours ?? null,
        available: funding !== null,
        ...(out.full ? { raw: funding } : {}),
      })),
    )
    .filter(
      (row) =>
        request.symbol === undefined || row.coin.toUpperCase() === request.symbol.toUpperCase(),
    )
    .filter(
      (row) =>
        request.venue === undefined || row.venue.toLowerCase() === request.venue.toLowerCase(),
    )
    .sort((a, b) => a.coin.localeCompare(b.coin) || a.venue.localeCompare(b.venue));
  const paged = pageRows(rows, request, { total: rows.length });
  emitSuccess(
    { count: paged.rows.length, total: rows.length, page: paged.page, funding: paged.rows },
    out,
    () =>
      renderTable(paged.rows, [
        "coin",
        "venue",
        "fundingRate",
        "fundingIntervalHours",
        "available",
      ]),
  );
  return 0;
}

export async function statusCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const status = await getExchangeStatus(ctx.infoOpts);
  emitSuccess({ network: ctx.flags.testnet ? "testnet" : "mainnet", ...status }, out, (value) =>
    renderTable([value as Row]),
  );
  return 0;
}
