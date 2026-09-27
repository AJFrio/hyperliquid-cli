import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AssetResolver } from "../../src/assets/resolve.js";
import { UsageError } from "../../src/errors.js";

/**
 * These run against JSON captured live from api.hyperliquid.xyz, so they lock
 * the real production shapes rather than shapes I invented.
 */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

const meta = fixture("meta.json") as {
  universe: { name: string; szDecimals: number; maxLeverage: number }[];
};
const spotMeta = fixture("spotMeta.json") as {
  universe: { name: string; index: number; tokens: [number, number]; isCanonical: boolean }[];
};
const allMids = fixture("allMids.json") as Record<string, string>;

const resolver = new AssetResolver({
  perps: meta.universe,
  spotPairs: spotMeta.universe,
  // Index 0 is the main perp dex (name ""), so "xyz" is dex index 1.
  perpDexs: [{ name: "" }, { name: "xyz" }],
  hip3Universes: [{ dex: "xyz", perps: [{ name: "XYZ100", szDecimals: 2, maxLeverage: 5 }] }],
});

describe("perp resolution against real meta", () => {
  it("maps BTC to its index in meta.universe", () => {
    const btc = resolver.resolvePerp("BTC");
    expect(btc.kind).toBe("perp");
    expect(btc.assetId).toBe(meta.universe.findIndex((a) => a.name === "BTC"));
    expect(btc.szDecimals).toBe(5);
  });

  it("is case-insensitive for convenience but returns canonical casing", () => {
    expect(resolver.resolvePerp("btc").assetId).toBe(resolver.resolvePerp("BTC").assetId);
    expect(resolver.resolvePerp("btc").symbol).toBe("BTC");
  });

  it("throws a structured UNKNOWN_ASSET for a coin that does not exist", () => {
    try {
      resolver.resolvePerp("NOTACOIN");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe("UNKNOWN_ASSET");
      expect((err as UsageError).exitCode).toBe(2);
    }
  });

  it("does not resolve a spot pair name as a perp", () => {
    expect(() => resolver.resolvePerp("PURR/USDC")).toThrow(UsageError);
  });
});

describe("spot resolution uses the 10000 + index offset", () => {
  it("maps the canonical PURR/USDC pair to 10000 + its index", () => {
    const pair = spotMeta.universe.find((p) => p.name === "PURR/USDC");
    expect(pair).toBeDefined();
    const resolved = resolver.resolveSpot("PURR/USDC");
    expect(resolved.kind).toBe("spot");
    expect(resolved.assetId).toBe(10_000 + (pair?.index ?? -1));
  });

  it("maps the @<index> form to the same asset id as the named pair", () => {
    const named = spotMeta.universe.find((p) => p.isCanonical && p.name.includes("/"));
    expect(named).toBeDefined();
    const viaName = resolver.resolveSpot(named?.name ?? "");
    const viaIndex = resolver.resolveSpot(`@${named?.index ?? -1}`);
    expect(viaIndex.assetId).toBe(viaName.assetId);
  });

  it("resolves a non-canonical pair whose name is itself @N", () => {
    const atName = spotMeta.universe.find((p) => p.name.startsWith("@"));
    expect(atName).toBeDefined();
    const resolved = resolver.resolveSpot(atName?.name ?? "");
    expect(resolved.assetId).toBe(10_000 + (atName?.index ?? -1));
  });

  it("rejects a dangling @index that is not in the universe", () => {
    expect(() => resolver.resolveSpot("@999999")).toThrow(UsageError);
  });
});

describe("HIP-3 resolution uses 100000 + dexIndex*10000 + index", () => {
  it("maps xyz:XYZ100 to 100000 + 1*10000 + 0 = 110000", () => {
    expect(resolver.resolveHip3("xyz:XYZ100").assetId).toBe(110_000);
  });

  it("is not resolvable as a plain perp", () => {
    expect(() => resolver.resolvePerp("xyz:XYZ100")).toThrow(UsageError);
  });
});

describe("resolveAny", () => {
  it("prefers a perp when the symbol is ambiguous with a spot name", () => {
    expect(resolver.resolveAny("BTC").kind).toBe("perp");
  });

  it("falls through to spot for a pair name", () => {
    expect(resolver.resolveAny("PURR/USDC").kind).toBe("spot");
  });
});

/**
 * Regression guard for the ambiguity that makes a naive `allMids` lookup wrong:
 * `PURR/USDC` is a spot pair but appears as a BARE key in allMids, while the
 * same pair is absent as `@0`. We never resolve against allMids for this reason.
 */
describe("why allMids keys are not a resolver", () => {
  it("allMids contains a bare spot pair name that is not a perp", () => {
    expect("PURR/USDC" in allMids).toBe(true);
    expect(meta.universe.some((a) => a.name === "PURR/USDC")).toBe(false);
  });

  it("allMids does not contain the @0 key even though spot index 0 exists", () => {
    expect("@0" in allMids).toBe(false);
    expect(spotMeta.universe.some((p) => p.index === 0)).toBe(true);
  });

  it("allMids carries opaque #index keys we deliberately do not support", () => {
    expect(Object.keys(allMids).some((k) => k.startsWith("#"))).toBe(true);
  });
});
