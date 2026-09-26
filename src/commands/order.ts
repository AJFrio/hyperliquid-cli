import { getOpenOrders, getOrderStatus } from "../api/info.js";
import { UsageError } from "../errors.js";
import { dispatch } from "./dispatch.js";
import {
  buildCancel,
  buildCancelByCloid,
  buildModify,
  buildOrder,
  buildScheduleCancel,
  type OrderInput,
  type OrderType,
  type OrderWire,
} from "../signing/buildAction.js";
import { emitSuccess, type OutputOptions } from "../cli/output.js";
import type { Context } from "../cli/context.js";

export interface PlaceArgs {
  symbol: string;
  side: "buy" | "sell";
  size: string;
  price?: string | undefined;
  spot: boolean;
  reduceOnly: boolean;
  tif: Tif;
  triggerPx?: string | undefined;
  triggerKind?: "tp" | "sl" | undefined;
  marketTrigger: boolean;
  cloid?: string | undefined;
  grouping?: "na" | "normalTpsl" | "positionTpsl" | undefined;
}

const TIFS = ["Gtc", "Ioc", "Alo", "FrontendMarket"] as const;
export type Tif = (typeof TIFS)[number];

export { TIFS };

export async function placeCmd(ctx: Context, args: PlaceArgs, out: OutputOptions): Promise<number> {
  const resolver = await ctx.assets();
  const asset = args.spot ? resolver.resolveSpot(args.symbol) : resolver.resolveAny(args.symbol);

  let type: OrderType;
  if (args.triggerPx !== undefined) {
    type = {
      trigger: {
        isMarket: args.marketTrigger,
        triggerPx: args.triggerPx,
        tpsl: args.triggerKind ?? "tp",
      },
    };
  } else {
    if (args.price === undefined) {
      throw new UsageError("USAGE", "--price is required unless --trigger-px is supplied", { symbol: args.symbol });
    }
    type = { limit: { tif: args.tif } };
  }

  const order: OrderInput = {
    asset: asset.assetId,
    isBuy: args.side === "buy",
    limitPx: args.price ?? args.triggerPx ?? "0",
    sz: args.size,
    reduceOnly: args.reduceOnly,
    type,
    ...(args.cloid === undefined ? {} : { cloid: args.cloid }),
  };

  const action = buildOrder([order], args.grouping ?? "na") as Record<string, unknown>;
  return dispatch(ctx, action, `order ${args.side} ${args.size} ${asset.symbol} @ ${order.limitPx}`, out);
}


export async function cancelCmd(
  ctx: Context,
  args: { symbol: string; oid: number; fast: boolean },
  out: OutputOptions,
): Promise<number> {
  const resolver = await ctx.assets();
  const asset = resolver.resolveAny(args.symbol);
  const action = buildCancel([{ asset: asset.assetId, oid: args.oid }], { fast: args.fast }) as Record<string, unknown>;
  return dispatch(ctx, action, `cancel oid ${args.oid} on ${asset.symbol}`, out);
}


export async function cancelByCloidCmd(
  ctx: Context,
  args: { symbol: string; cloid: string; fast: boolean },
  out: OutputOptions,
): Promise<number> {
  const resolver = await ctx.assets();
  const asset = resolver.resolveAny(args.symbol);
  const action = buildCancelByCloid([{ asset: asset.assetId, cloid: args.cloid.toLowerCase() }], {
    fast: args.fast,
  }) as Record<string, unknown>;
  return dispatch(ctx, action, `cancel cloid ${args.cloid} on ${asset.symbol}`, out);
}

/**
 * Cancel every open order by reading `openOrders` and batch-cancelling the real
 * order ids. The exchange has no dedicated "cancel everything" action, so this
 * is the only honest implementation; an empty open-orders list is a no-op
 * success rather than an error.
 */

export async function cancelAllCmd(
  ctx: Context,
  args: { symbol?: string | undefined; fast: boolean },
  out: OutputOptions,
): Promise<number> {
  const cfg = await ctx.config();
  const rows = (await getOpenOrders(cfg.accountAddress, ctx.infoOpts)) as {
    coin: string;
    oid: number;
  }[];
  const resolver = await ctx.assets();
  const targets = rows
    .filter((r) => args.symbol === undefined || r.coin.toUpperCase() === args.symbol.toUpperCase())
    .map((r) => {
      const asset = resolver.resolveAny(r.coin);
      return { asset: asset.assetId, oid: r.oid };
    });

  if (targets.length === 0) {
    emitSuccess({ cancelled: 0, note: "no matching open orders" }, out);
    return 0;
  }
  const action = buildCancel(targets, { fast: args.fast }) as Record<string, unknown>;
  return dispatch(ctx, action, `cancel ${targets.length} open order(s)`, out);
}

/**
 * Modify an existing order. The asset, side and reduceOnly flags are read back
 * from the exchange rather than assumed, because a modify replaces the whole
 * order body - guessing any of them would silently flip a position.
 */

export async function modifyCmd(
  ctx: Context,
  args: { oid: number; price?: string | undefined; size?: string | undefined; tif?: Tif | undefined; alwaysPlace: boolean },
  out: OutputOptions,
): Promise<number> {
  if (args.price === undefined && args.size === undefined) {
    throw new UsageError("USAGE", "supply at least one of --price or --size to modify");
  }
  const cfg = await ctx.config();
  const status = (await getOrderStatus(cfg.accountAddress, args.oid, ctx.infoOpts)) as {
    status: string;
    order?: { order?: Record<string, unknown> };
  };
  if (status.status !== "order" || status.order?.order === undefined) {
    throw new UsageError("INVALID_INPUT", `oid ${args.oid} is not a live order (status: ${status.status})`, {
      oid: args.oid,
      status: status.status,
    });
  }
  const current = status.order.order;
  const currentType = current["t"] as OrderType | undefined;
  const wire: OrderWire = {
    a: Number(current["a"]),
    b: Boolean(current["b"]),
    p: args.price ?? String(current["p"]),
    s: args.size ?? String(current["s"]),
    r: Boolean(current["r"]),
    t: args.tif === undefined ? (currentType ?? { limit: { tif: "Gtc" as Tif } }) : { limit: { tif: args.tif } },
  };
  const action = buildModify(args.oid, wire, { alwaysPlace: args.alwaysPlace }) as Record<string, unknown>;
  return dispatch(ctx, action, `modify oid ${args.oid}`, out);
}


export async function scheduleCancelCmd(ctx: Context, args: { at?: string | undefined; clear: boolean }, out: OutputOptions): Promise<number> {
  let timeMs: number | undefined;
  if (args.clear) {
    timeMs = undefined;
  } else {
    if (args.at === undefined) {
      throw new UsageError("USAGE", "--at <ISO timestamp> is required unless --clear is passed");
    }
    const parsed = Date.parse(args.at);
    if (Number.isNaN(parsed)) {
      throw new UsageError("USAGE", `--at is not a parseable timestamp: ${args.at}`, { at: args.at });
    }
    if (parsed <= Date.now()) {
      throw new UsageError("USAGE", "--at must be at least 5 seconds in the future (the exchange rejects sooner)", { at: args.at });
    }
    timeMs = parsed;
  }
  const action = buildScheduleCancel(timeMs) as Record<string, unknown>;
  return dispatch(ctx, action, timeMs === undefined ? "clear dead-man switch" : `arm dead-man switch at ${args.at}`, out);
}

