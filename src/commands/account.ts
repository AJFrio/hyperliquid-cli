import {
  getClearinghouseState,
  getLedger,
  getOpenOrders,
  getOrderStatus,
  getRateLimit,
  getSpotClearinghouseState,
  getUserFills,
  getUserFillsByTime,
  getUserFunding,
  getUserRole,
} from "../api/info.js";
import type { Context } from "../cli/context.js";
import {
  emitSuccess,
  type OutputOptions,
  type PageRequest,
  pageRows,
  renderTable,
} from "../cli/output.js";
import { UsageError } from "../errors.js";

type Row = Record<string, unknown>;

async function accountOf(ctx: Context): Promise<string> {
  return (await ctx.config()).accountAddress;
}

function objectOf(value: unknown): Row {
  return typeof value === "object" && value !== null ? (value as Row) : {};
}

function pick(row: unknown, fields: string[]): Row {
  const source = objectOf(row);
  return Object.fromEntries(
    fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]),
  );
}

function cappedPage<T>(rows: T[], request: PageRequest, cap: number) {
  const sourceLimited = rows.length >= cap;
  return pageRows(rows, request, { sourceLimited, total: sourceLimited ? null : rows.length });
}

export async function stateCmd(
  ctx: Context,
  opts: PageRequest & { dex?: string | undefined },
  out: OutputOptions,
): Promise<number> {
  const cfg = await ctx.config();
  const user = cfg.accountAddress;
  const dex = opts.dex === undefined ? undefined : await ctx.resolveDexName(opts.dex);
  const state = objectOf(await getClearinghouseState(user, ctx.infoOpts, dex));
  const positions = Array.isArray(state.assetPositions) ? state.assetPositions : [];
  const positionRows = positions.map((entry) => objectOf(objectOf(entry).position ?? entry));
  const paged = pageRows(positionRows, opts, { total: positionRows.length });
  const summary = pick(state, [
    "marginSummary",
    "crossMarginSummary",
    "crossMaintenanceMarginUsed",
    "withdrawable",
    "time",
  ]);
  const payload = {
    user,
    network: cfg.network,
    dex: dex || "primary",
    summary,
    count: paged.rows.length,
    total: positionRows.length,
    page: paged.page,
    positions: out.full
      ? paged.rows
      : paged.rows.map((row) =>
          pick(row, [
            "coin",
            "szi",
            "entryPx",
            "positionValue",
            "unrealizedPnl",
            "returnOnEquity",
            "liquidationPx",
            "marginUsed",
            "leverage",
            "maxLeverage",
          ]),
        ),
  };
  emitSuccess(payload, out, (value) => {
    const v = value as { positions?: Row[]; state?: Row };
    return renderTable(v.positions ?? [], [
      "coin",
      "szi",
      "positionValue",
      "unrealizedPnl",
      "leverage",
    ]);
  });
  return 0;
}

export async function spotCmd(
  ctx: Context,
  request: PageRequest,
  out: OutputOptions,
): Promise<number> {
  const user = await accountOf(ctx);
  const state = objectOf(await getSpotClearinghouseState(user, ctx.infoOpts));
  const balances = Array.isArray(state.balances) ? state.balances.map(objectOf) : [];
  const paged = pageRows(balances, request, { total: balances.length });
  const payload = {
    user,
    count: paged.rows.length,
    total: balances.length,
    page: paged.page,
    balances: out.full
      ? paged.rows
      : paged.rows.map((row) => pick(row, ["coin", "token", "hold", "total", "entryNtl"])),
  };
  emitSuccess(payload, out, (value) => {
    const v = value as { balances?: Row[] };
    return renderTable(v.balances ?? [], ["coin", "token", "hold", "total", "entryNtl"]);
  });
  return 0;
}

export async function ordersCmd(
  ctx: Context,
  opts: PageRequest & { dex?: string | undefined },
  out: OutputOptions,
): Promise<number> {
  const user = await accountOf(ctx);
  const dex = opts.dex === undefined ? undefined : await ctx.resolveDexName(opts.dex);
  const rows = (await getOpenOrders(user, ctx.infoOpts, dex)).map(objectOf);
  const ordered = [...rows].sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));
  const paged = pageRows(ordered, opts, { total: ordered.length });
  const orders = out.full
    ? paged.rows
    : paged.rows.map((row) =>
        pick(row, [
          "coin",
          "side",
          "limitPx",
          "sz",
          "oid",
          "timestamp",
          "reduceOnly",
          "orderType",
          "isTrigger",
          "triggerPx",
          "cloid",
        ]),
      );
  emitSuccess(
    {
      user,
      dex: dex || "primary",
      count: orders.length,
      total: rows.length,
      page: paged.page,
      orders,
    },
    out,
    () => renderTable(orders, ["coin", "side", "limitPx", "sz", "oid"]),
  );
  return 0;
}

export async function orderStatusCmd(
  ctx: Context,
  oid: string,
  out: OutputOptions,
): Promise<number> {
  const user = await accountOf(ctx);
  const parsed: number | string = /^\d+$/.test(oid) ? Number(oid) : oid.toLowerCase();
  const status = await getOrderStatus(user, parsed, ctx.infoOpts);
  if (out.full) {
    emitSuccess({ user, oid: parsed, status }, out);
    return 0;
  }
  const raw = objectOf(status);
  const orderState = objectOf(raw.order);
  const order = objectOf(orderState.order);
  emitSuccess(
    {
      user,
      oid: parsed,
      status: raw.status ?? null,
      order:
        Object.keys(order).length === 0
          ? null
          : pick(order, [
              "coin",
              "side",
              "limitPx",
              "sz",
              "origSz",
              "oid",
              "timestamp",
              "reduceOnly",
              "orderType",
              "isTrigger",
              "triggerPx",
              "cloid",
            ]),
      statusTimestamp: raw.statusTimestamp ?? orderState.statusTimestamp ?? null,
    },
    out,
  );
  return 0;
}

export async function fillsCmd(
  ctx: Context,
  opts: PageRequest & { sinceHours?: number | undefined; endTime?: number | undefined },
  out: OutputOptions,
): Promise<number> {
  if (
    opts.sinceHours !== undefined &&
    (!Number.isFinite(opts.sinceHours) || opts.sinceHours <= 0)
  ) {
    throw new UsageError("USAGE", "--since-hours must be greater than zero");
  }
  if (opts.endTime !== undefined && !Number.isFinite(opts.endTime)) {
    throw new UsageError("USAGE", "--end must be an ISO 8601 timestamp or epoch milliseconds");
  }
  if (opts.endTime !== undefined && opts.sinceHours === undefined) {
    throw new UsageError("USAGE", "--end requires --since-hours on account fills");
  }
  const user = await accountOf(ctx);
  const endTime = opts.endTime ?? Date.now();
  const startTime =
    opts.sinceHours === undefined ? undefined : endTime - opts.sinceHours * 3_600_000;
  const rows = (
    startTime === undefined
      ? await getUserFills(user, ctx.infoOpts)
      : await getUserFillsByTime(user, startTime, endTime, ctx.infoOpts)
  ).map(objectOf);
  const ordered = [...rows].sort(
    (a, b) => Number(b.time ?? b.timestamp ?? 0) - Number(a.time ?? a.timestamp ?? 0),
  );
  const paged = cappedPage(ordered, opts, 2000);
  const fills = out.full
    ? paged.rows
    : paged.rows.map((row) =>
        pick(row, [
          "time",
          "coin",
          "side",
          "px",
          "sz",
          "dir",
          "fee",
          "feeToken",
          "closedPnl",
          "oid",
          "tid",
          "crossed",
        ]),
      );
  emitSuccess(
    {
      user,
      ...(startTime === undefined ? {} : { requested: { startTime, endTime } }),
      count: fills.length,
      total: paged.page.total,
      page: paged.page,
      fills,
    },
    out,
    () => renderTable(fills, ["time", "coin", "side", "px", "sz", "dir"]),
  );
  return 0;
}

export async function fundingCmd(
  ctx: Context,
  opts: PageRequest & { sinceHours: number; endTime?: number | undefined },
  out: OutputOptions,
): Promise<number> {
  if (!Number.isFinite(opts.sinceHours) || opts.sinceHours <= 0)
    throw new UsageError("USAGE", "--since-hours must be greater than zero");
  if (opts.endTime !== undefined && !Number.isFinite(opts.endTime))
    throw new UsageError("USAGE", "--end must be an ISO 8601 timestamp or epoch milliseconds");
  const user = await accountOf(ctx);
  const endTime = opts.endTime ?? Date.now();
  const startTime = endTime - opts.sinceHours * 3_600_000;
  const rows = (await getUserFunding(user, startTime, ctx.infoOpts, endTime)).map(objectOf);
  const ordered = [...rows].sort((a, b) => Number(b.time ?? 0) - Number(a.time ?? 0));
  const paged = cappedPage(ordered, opts, 500);
  const funding = out.full
    ? paged.rows
    : paged.rows.map((row) => pick(row, ["time", "coin", "usdc", "fundingRate", "hash", "tid"]));
  emitSuccess(
    {
      user,
      requested: { startTime, endTime },
      count: funding.length,
      total: paged.page.total,
      page: paged.page,
      funding,
    },
    out,
    () => renderTable(funding, ["time", "coin", "usdc", "fundingRate"]),
  );
  return 0;
}

export async function ledgerCmd(
  ctx: Context,
  opts: PageRequest & { sinceHours: number; endTime?: number | undefined },
  out: OutputOptions,
): Promise<number> {
  if (!Number.isFinite(opts.sinceHours) || opts.sinceHours <= 0)
    throw new UsageError("USAGE", "--since-hours must be greater than zero");
  if (opts.endTime !== undefined && !Number.isFinite(opts.endTime))
    throw new UsageError("USAGE", "--end must be an ISO 8601 timestamp or epoch milliseconds");
  const user = await accountOf(ctx);
  const endTime = opts.endTime ?? Date.now();
  const startTime = endTime - opts.sinceHours * 3_600_000;
  const rows = (await getLedger(user, startTime, ctx.infoOpts, endTime)).map(objectOf);
  const ordered = [...rows].sort((a, b) => Number(b.time ?? 0) - Number(a.time ?? 0));
  const paged = cappedPage(ordered, opts, 500);
  const ledger = out.full
    ? paged.rows
    : paged.rows.map((row) => pick(row, ["time", "type", "usdc", "coin", "delta", "hash", "tid"]));
  emitSuccess(
    {
      user,
      requested: { startTime, endTime },
      count: ledger.length,
      total: paged.page.total,
      page: paged.page,
      ledger,
    },
    out,
    () => renderTable(ledger, ["time", "type", "usdc", "coin"]),
  );
  return 0;
}

export async function rateLimitCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const user = await accountOf(ctx);
  const limit = await getRateLimit(user, ctx.infoOpts);
  emitSuccess({ user, rateLimit: limit }, out);
  return 0;
}

export async function roleCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const user = await accountOf(ctx);
  const role = await getUserRole(user, ctx.infoOpts);
  emitSuccess({ user, role }, out);
  return 0;
}

export { UsageError };
