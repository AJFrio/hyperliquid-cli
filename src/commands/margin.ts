import { UsageError } from "../errors.js";
import { dispatch } from "./dispatch.js";
import { buildTopUpIsolatedOnlyMargin, buildUpdateIsolatedMargin, buildUpdateLeverage } from "../signing/buildAction.js";
import type { OutputOptions } from "../cli/output.js";
import type { Context } from "../cli/context.js";

export async function leverageCmd(
  ctx: Context,
  args: { symbol: string; leverage: number; cross?: boolean | undefined; isolated?: boolean | undefined },
  out: OutputOptions,
): Promise<number> {
  if ((args.cross === true) === (args.isolated === true)) {
    throw new UsageError("USAGE", "choose exactly one of --cross or --isolated");
  }
  const resolver = await ctx.assets();
  const asset = resolver.resolveAny(args.symbol);
  const action = buildUpdateLeverage(asset.assetId, args.leverage, args.cross === true) as Record<string, unknown>;
  return dispatch(ctx, action, `set ${asset.symbol} leverage to ${args.leverage}x ${args.cross ? "cross" : "isolated"}`, out);
}


export async function addMarginCmd(
  ctx: Context,
  args: { symbol: string; usd: number; side: "long" | "short" },
  out: OutputOptions,
): Promise<number> {
  const resolver = await ctx.assets();
  const asset = resolver.resolveAny(args.symbol);
  const action = buildUpdateIsolatedMargin(asset.assetId, args.usd, args.side === "long") as Record<string, unknown>;
  return dispatch(ctx, action, `add $${args.usd} isolated margin to ${asset.symbol} ${args.side}`, out);
}


export async function topUpCmd(
  ctx: Context,
  args: { symbol: string; leverage: number },
  out: OutputOptions,
): Promise<number> {
  const resolver = await ctx.assets();
  const asset = resolver.resolveAny(args.symbol);
  const action = buildTopUpIsolatedOnlyMargin(asset.assetId, args.leverage) as Record<string, unknown>;
  return dispatch(ctx, action, `top up ${asset.symbol} to ${args.leverage}x`, out);
}

