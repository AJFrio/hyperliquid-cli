import type { Context } from "../cli/context.js";
import type { OutputOptions } from "../cli/output.js";
import { buildTwapCancel, buildTwapOrder } from "../signing/buildAction.js";
import { dispatch } from "./dispatch.js";

export async function twapPlaceCmd(
  ctx: Context,
  args: { symbol: string; side: "buy" | "sell"; size: string; minutes: number; randomize: boolean },
  out: OutputOptions,
): Promise<number> {
  const asset = await ctx.resolveAny(args.symbol);
  const action = buildTwapOrder({
    a: asset.assetId,
    b: args.side === "buy",
    s: args.size,
    r: false,
    m: args.minutes,
    t: args.randomize,
  }) as Record<string, unknown>;
  return dispatch(
    ctx,
    action,
    `twap ${args.side} ${args.size} ${asset.symbol} over ${args.minutes}m`,
    out,
  );
}

export async function twapCancelCmd(
  ctx: Context,
  args: { symbol: string; twapId: number },
  out: OutputOptions,
): Promise<number> {
  const asset = await ctx.resolveAny(args.symbol);
  const action = buildTwapCancel(asset.assetId, args.twapId) as Record<string, unknown>;
  return dispatch(ctx, action, `cancel twap ${args.twapId} on ${asset.symbol}`, out);
}
