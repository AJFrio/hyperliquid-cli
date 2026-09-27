// Runtime VALUES, not types: canonicalize() reads `.entries.action` for key order.
// Re-adding `type` here erases them and breaks signing at runtime, not compile time.
import {
  BatchModifyRequest,
  CancelByCloidRequest,
  CancelRequest,
  ModifyRequest,
  OrderRequest,
  ScheduleCancelRequest,
  TopUpIsolatedOnlyMarginRequest,
  TwapCancelRequest,
  TwapOrderRequest,
  UpdateIsolatedMarginRequest,
  UpdateLeverageRequest,
} from "@nktkas/hyperliquid/api/exchange";
import { canonicalize } from "@nktkas/hyperliquid/signing";
import { UsageError } from "../errors.js";

/**
 * Build a canonicalised exchange action ready for signing.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Hyperliquid hashes the msgpack encoding of the action, and msgpack key order
 * matters. We must therefore run every action through the SDK's
 * `canonicalize()` with the matching valibot schema. Hand-building objects
 * produces signatures the exchange rejects.
 *
 * THE FALSE-OMISSION RULE
 * -----------------------
 * `cancel.f`, `cancelByCloid.f`, `modify.a` and `batchModify.a` are OPTIONAL
 * booleans that MUST BE ABSENT when false - the exchange rejects a request whose
 * hash includes an explicit `false`. `canonicalize()` does NOT strip them for
 * us; we verified this empirically (distinct hashes for present vs omitted).
 *
 * This stripping is deliberately TARGETED, not a blanket "remove all false
 * booleans". Inside an order, `r` (reduceOnly) and `b` (isBuy) are REQUIRED and
 * `false` is meaningful - stripping them would silently change the order.
 */

/** Delete a top-level optional boolean when it is `false`. Never touches nested objects. */
function omitFalseFlag<T extends Record<string, unknown>>(action: T, key: string): T {
  if (action[key] === false) {
    const { [key]: _removed, ...rest } = action;
    return rest as T;
  }
  return action;
}

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: OrderType;
  c?: string;
}

export type OrderType =
  | { limit: { tif: "Gtc" | "Ioc" | "Alo" | "FrontendMarket" } }
  | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };

export type Grouping = "na" | "normalTpsl" | "positionTpsl";

export interface OrderInput {
  asset: number;
  isBuy: boolean;
  /** Decimal string. Never a float: "50000" not 50000.0 */
  limitPx: string;
  /** Decimal string in base units. */
  sz: string;
  reduceOnly: boolean;
  type: OrderType;
  cloid?: string | undefined;
}

export function buildOrder(
  orders: OrderInput[],
  grouping: Grouping = "na",
  builder?: { b: string; f: number },
): unknown {
  if (orders.length === 0) {
    throw new UsageError("INVALID_INPUT", "at least one order is required");
  }
  const wire = orders.map((o) => {
    if (!Number.isInteger(o.asset) || o.asset < 0) {
      throw new UsageError(
        "INVALID_INPUT",
        `asset id must be a non-negative integer, got ${String(o.asset)}`,
        { asset: o.asset },
      );
    }
    assertDecimalString(o.limitPx, "limit price");
    assertDecimalString(o.sz, "size");
    return {
      a: o.asset,
      b: o.isBuy,
      p: o.limitPx,
      s: o.sz,
      r: o.reduceOnly,
      t: o.type,
      ...(o.cloid === undefined ? {} : { c: o.cloid }),
    };
  });
  return canonicalize(OrderRequest.entries.action, {
    type: "order",
    orders: wire,
    grouping,
    ...(builder === undefined ? {} : { builder }),
  });
}

export function buildCancel(
  cancels: { asset: number; oid: number }[],
  opts: { fast: boolean },
): unknown {
  const action = {
    type: "cancel" as const,
    cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })),
    f: opts.fast,
  };
  return canonicalize(
    CancelRequest.entries.action,
    omitFalseFlag(action as unknown as Record<string, unknown>, "f"),
  );
}

export function buildCancelByCloid(
  cancels: { asset: number; cloid: string }[],
  opts: { fast: boolean },
): unknown {
  const action = { type: "cancelByCloid" as const, cancels, f: opts.fast };
  return canonicalize(
    CancelByCloidRequest.entries.action,
    omitFalseFlag(action as unknown as Record<string, unknown>, "f"),
  );
}

export function buildModify(
  oid: number | string,
  order: OrderWire,
  opts: { alwaysPlace: boolean },
): unknown {
  const action = { type: "modify" as const, oid, order, a: opts.alwaysPlace };
  return canonicalize(
    ModifyRequest.entries.action,
    omitFalseFlag(action as unknown as Record<string, unknown>, "a"),
  );
}

export function buildBatchModify(
  modifies: { oid: number | string; order: OrderWire }[],
  opts: { alwaysPlace: boolean },
): unknown {
  const action = { type: "batchModify" as const, modifies, a: opts.alwaysPlace };
  return canonicalize(
    BatchModifyRequest.entries.action,
    omitFalseFlag(action as unknown as Record<string, unknown>, "a"),
  );
}

export function buildScheduleCancel(timeMs?: number): unknown {
  return canonicalize(ScheduleCancelRequest.entries.action, {
    type: "scheduleCancel",
    ...(timeMs === undefined ? {} : { time: timeMs }),
  });
}

export function buildUpdateLeverage(asset: number, leverage: number, isCross: boolean): unknown {
  if (!Number.isInteger(asset) || asset < 0) {
    throw new UsageError(
      "INVALID_INPUT",
      `asset id must be a non-negative integer, got ${String(asset)}`,
      { asset },
    );
  }
  if (!Number.isInteger(leverage) || leverage < 1) {
    throw new UsageError(
      "INVALID_INPUT",
      `leverage must be a positive integer, got ${String(leverage)}`,
      { leverage },
    );
  }
  return canonicalize(UpdateLeverageRequest.entries.action, {
    type: "updateLeverage",
    asset,
    isCross,
    leverage,
  });
}

/** `ntli` is in 1e-6 USDC units: 1_000_000 == $1. */
export function buildUpdateIsolatedMargin(asset: number, usd: number, isBuy: boolean): unknown {
  const ntli = Math.round(usd * 1_000_000);
  if (!Number.isFinite(ntli) || ntli <= 0) {
    throw new UsageError(
      "INVALID_INPUT",
      `isolated margin amount must be positive, got ${String(usd)}`,
      { usd },
    );
  }
  return canonicalize(UpdateIsolatedMarginRequest.entries.action, {
    type: "updateIsolatedMargin",
    asset,
    isBuy,
    ntli,
  });
}

export function buildTopUpIsolatedOnlyMargin(asset: number, leverage: number): unknown {
  return canonicalize(TopUpIsolatedOnlyMarginRequest.entries.action, {
    type: "topUpIsolatedOnlyMargin",
    asset,
    leverage: String(leverage),
  });
}

export function buildTwapOrder(twap: {
  a: number;
  b: boolean;
  s: string;
  r: boolean;
  m: number;
  t: boolean;
}): unknown {
  assertDecimalString(twap.s, "twap size");
  if (!Number.isInteger(twap.m) || twap.m < 1) {
    throw new UsageError(
      "INVALID_INPUT",
      `twap duration must be a positive integer number of minutes, got ${String(twap.m)}`,
      { minutes: twap.m },
    );
  }
  return canonicalize(TwapOrderRequest.entries.action, { type: "twapOrder", twap });
}

export function buildTwapCancel(asset: number, twapId: number): unknown {
  return canonicalize(TwapCancelRequest.entries.action, {
    type: "twapCancel",
    a: asset,
    t: twapId,
  });
}

function assertDecimalString(value: string, what: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError("INVALID_INPUT", `${what} must be a non-empty decimal string`, { value });
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new UsageError(
      "INVALID_INPUT",
      `${what} must be a positive decimal string like "0.01", got ${value}`,
      { value },
    );
  }
  if (Number(value) <= 0) {
    throw new UsageError("INVALID_INPUT", `${what} must be greater than zero, got ${value}`, {
      value,
    });
  }
}
