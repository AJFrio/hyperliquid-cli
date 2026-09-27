import {
  getClearinghouseState,
  getLedger,
  getOpenOrders,
  getOrderStatus,
  getRateLimit,
  getSpotClearinghouseState,
  getUserFills,
  getUserFunding,
  getUserRole,
} from "../api/info.js";
import type { Context } from "../cli/context.js";
import { emitSuccess, type OutputOptions, renderTable } from "../cli/output.js";
import { UsageError } from "../errors.js";

async function accountOf(ctx: Context): Promise<string> {
  return (await ctx.config()).accountAddress;
}

export async function stateCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const user = await accountOf(ctx);
  const state = await getClearinghouseState(user, ctx.infoOpts);
  emitSuccess({ user, network: (await ctx.config()).network, state }, out, (v) => {
    const s = v as { state: { assetPositions?: unknown[] } };
    return renderTable(s.state.assetPositions ?? [], [
      "coin",
      "szi",
      "positionValue",
      "unrealizedPnl",
      "leverage",
    ]);
  });
  return 0;
}

export async function spotCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const user = await accountOf(ctx);
  const state = await getSpotClearinghouseState(user, ctx.infoOpts);
  emitSuccess({ user, state }, out, (v) => {
    const s = v as { state: { balances?: unknown[] } };
    return renderTable(s.state.balances ?? [], ["coin", "token", "hold", "total", "entryNtl"]);
  });
  return 0;
}

export async function ordersCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const user = await accountOf(ctx);
  const rows = await getOpenOrders(user, ctx.infoOpts);
  emitSuccess({ user, count: rows.length, orders: rows }, out, () =>
    renderTable(rows, ["coin", "side", "limitPx", "sz", "oid"]),
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
  emitSuccess({ user, oid: parsed, status }, out);
  return 0;
}

export async function fillsCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const user = await accountOf(ctx);
  const rows = await getUserFills(user, ctx.infoOpts);
  emitSuccess({ user, count: rows.length, fills: rows }, out, () =>
    renderTable(rows, ["time", "coin", "side", "px", "sz", "dir"]),
  );
  return 0;
}

export async function fundingCmd(
  ctx: Context,
  opts: { sinceHours: number },
  out: OutputOptions,
): Promise<number> {
  const user = await accountOf(ctx);
  const startTime = Date.now() - opts.sinceHours * 3_600_000;
  const rows = await getUserFunding(user, startTime, ctx.infoOpts);
  emitSuccess({ user, startTime, count: rows.length, funding: rows }, out, () =>
    renderTable(rows, ["time", "coin", "usdc", "fundingRate"]),
  );
  return 0;
}

export async function ledgerCmd(
  ctx: Context,
  opts: { sinceHours: number },
  out: OutputOptions,
): Promise<number> {
  const user = await accountOf(ctx);
  const startTime = Date.now() - opts.sinceHours * 3_600_000;
  const rows = await getLedger(user, startTime, ctx.infoOpts);
  emitSuccess({ user, startTime, count: rows.length, ledger: rows }, out, () =>
    renderTable(rows, ["time", "type", "usdc", "coin"]),
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
