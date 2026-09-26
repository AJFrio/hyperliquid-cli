import { describe, expect, it } from "vitest";
import {
  buildBatchModify,
  buildCancel,
  buildCancelByCloid,
  buildModify,
  buildOrder,
  buildScheduleCancel,
  buildTwapOrder,
  buildUpdateIsolatedMargin,
  buildUpdateLeverage,
  type OrderInput,
  type OrderWire,
} from "../../src/signing/buildAction.js";
import { UsageError } from "../../src/errors.js";

const order: OrderInput = {
  asset: 0,
  isBuy: true,
  limitPx: "50000",
  sz: "0.01",
  reduceOnly: false,
  type: { limit: { tif: "Gtc" } },
};

const wire: OrderWire = {
  a: 0,
  b: true,
  p: "50000",
  s: "0.01",
  r: false,
  t: { limit: { tif: "Gtc" } },
};

describe("buildOrder", () => {
  it("emits schema key order and no cloid when none was given", () => {
    const action = buildOrder([order]) as { type: string; orders: Record<string, unknown>[]; grouping: string };
    expect(Object.keys(action)).toEqual(["type", "orders", "grouping"]);
    expect(action.type).toBe("order");
    expect(Object.keys(action.orders[0] as object)).toEqual(["a", "b", "p", "s", "r", "t"]);
  });

  it("preserves reduceOnly false inside an order - it is required, not optional", () => {
    const action = buildOrder([order]) as { orders: { r: boolean }[] };
    expect(action.orders[0]?.r).toBe(false);
  });

  it("appends the cloid only when supplied", () => {
    const withCloid = buildOrder([{ ...order, cloid: `0x${"ab".repeat(16)}` }]) as { orders: Record<string, unknown>[] };
    expect(Object.keys(withCloid.orders[0] as object)).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
  });

  it("accepts a batch in the same action rather than a separate batch action", () => {
    const action = buildOrder([order, { ...order, isBuy: false }]) as { orders: unknown[] };
    expect(action.orders).toHaveLength(2);
  });

  it("rejects an empty order list", () => {
    expect(() => buildOrder([])).toThrow(UsageError);
  });

  it("rejects a non-integer or negative asset id", () => {
    expect(() => buildOrder([{ ...order, asset: -1 }])).toThrow(/asset id/);
    expect(() => buildOrder([{ ...order, asset: 1.5 }])).toThrow(/asset id/);
  });

  it("rejects prices or sizes that are not positive decimal strings", () => {
    expect(() => buildOrder([{ ...order, limitPx: "-5" }])).toThrow(/limit price/);
    expect(() => buildOrder([{ ...order, sz: "0" }])).toThrow(/size/);
    expect(() => buildOrder([{ ...order, limitPx: "1e5" }])).toThrow(/limit price/);
  });

  it("keeps prices as strings, never coercing to a float", () => {
    const action = buildOrder([{ ...order, limitPx: "50000.10" }]) as { orders: { p: unknown }[] };
    expect(typeof action.orders[0]?.p).toBe("string");
    expect(action.orders[0]?.p).toBe("50000.10");
  });
});

describe("THE FALSE-OMISSION RULE (cancel.f / cancelByCloid.f / modify.a / batchModify.a)", () => {
  it("omits f entirely when fast is false", () => {
    const action = buildCancel([{ asset: 0, oid: 123 }], { fast: false }) as Record<string, unknown>;
    expect(Object.keys(action)).toEqual(["type", "cancels"]);
    expect("f" in action).toBe(false);
  });

  it("includes f when fast is true", () => {
    const action = buildCancel([{ asset: 0, oid: 123 }], { fast: true }) as Record<string, unknown>;
    expect(Object.keys(action)).toEqual(["type", "cancels", "f"]);
    expect(action["f"]).toBe(true);
  });

  it("omits f on cancelByCloid when fast is false", () => {
    const action = buildCancelByCloid([{ asset: 0, cloid: `0x${"cd".repeat(16)}` }], { fast: false }) as Record<string, unknown>;
    expect("f" in action).toBe(false);
  });

  it("omits a on modify when alwaysPlace is false", () => {
    const action = buildModify(123, wire, { alwaysPlace: false }) as Record<string, unknown>;
    expect("a" in action).toBe(false);
  });

  it("includes a on modify when alwaysPlace is true", () => {
    const action = buildModify(123, wire, { alwaysPlace: true }) as Record<string, unknown>;
    expect(action["a"]).toBe(true);
  });

  it("omits a on batchModify when alwaysPlace is false", () => {
    const action = buildBatchModify([{ oid: 1, order: wire }], { alwaysPlace: false }) as Record<string, unknown>;
    expect("a" in action).toBe(false);
  });
});

describe("cancel key asymmetry", () => {
  it("uses short a/o keys for cancel", () => {
    const action = buildCancel([{ asset: 7, oid: 99 }], { fast: false }) as { cancels: Record<string, unknown>[] };
    expect(Object.keys(action.cancels[0] as object)).toEqual(["a", "o"]);
  });

  it("uses long asset/cloid keys for cancelByCloid", () => {
    const cloid = `0x${"ef".repeat(16)}`;
    const action = buildCancelByCloid([{ asset: 7, cloid }], { fast: false }) as { cancels: Record<string, unknown>[] };
    expect(Object.keys(action.cancels[0] as object)).toEqual(["asset", "cloid"]);
    expect(action.cancels[0]?.cloid).toBe(cloid);
  });
});

describe("margin and schedule builders", () => {
  it("converts dollars into 1e-6 USDC units for isolated margin", () => {
    const action = buildUpdateIsolatedMargin(3, 1, true) as { ntli: number };
    expect(action.ntli).toBe(1_000_000);
    expect(buildUpdateIsolatedMargin(3, 0.5, false) as { ntli: number }).toMatchObject({ ntli: 500_000 });
  });

  it("rejects a non-positive isolated margin amount", () => {
    expect(() => buildUpdateIsolatedMargin(3, 0, true)).toThrow(UsageError);
    expect(() => buildUpdateIsolatedMargin(3, -1, true)).toThrow(UsageError);
  });

  it("rejects a non-positive or non-integer leverage", () => {
    expect(() => buildUpdateLeverage(0, 0, true)).toThrow(/leverage/);
    expect(() => buildUpdateLeverage(0, 2.5, true)).toThrow(/leverage/);
  });

  it("omits time on scheduleCancel to clear it, and includes it to arm it", () => {
    expect("time" in (buildScheduleCancel() as object)).toBe(false);
    expect((buildScheduleCancel(Date.now() + 60_000) as { time: number }).time).toBeGreaterThan(0);
  });

  it("rejects a twap duration under one minute", () => {
    expect(() => buildTwapOrder({ a: 0, b: true, s: "1", r: false, m: 0, t: false })).toThrow(/minutes/);
  });
});
