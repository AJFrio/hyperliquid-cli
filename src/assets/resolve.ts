import { UsageError } from "../errors.js";

/**
 * Symbol -> Hyperliquid asset-id resolution.
 *
 * WHY WE DO NOT USE `allMids` KEYS
 * --------------------------------
 * The live `allMids` response mixes THREE disjoint namespaces into one flat
 * object: 235 bare names (234 perps + the spot pair name `PURR/USDC`), 418
 * `@<index>` spot keys, and 466 `#<index>` opaque keys. Resolving a user symbol
 * against those keys is therefore ambiguous AND accepts delisted instruments.
 * We always resolve against the authoritative `meta.universe` / `spotMeta.universe`.
 */

export const PERP_OFFSET = 0;
export const SPOT_OFFSET = 10_000;
export const HIP3_OFFSET = 100_000;
export const HIP3_DEX_STRIDE = 10_000;

export interface PerpAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

export interface SpotPair {
  name: string;
  index: number;
  tokens: [number, number];
  isCanonical?: boolean | undefined;
}

export type AssetKind = "perp" | "spot" | "hip3";

export interface ResolvedAsset {
  kind: AssetKind;
  assetId: number;
  symbol: string;
  szDecimals: number;
}

export class AssetResolver {
  private readonly perps: Map<string, { index: number; asset: PerpAsset }>;
  private readonly spot: Map<string, { index: number; pair: SpotPair }>;
  private readonly spotByIndex: Map<number, SpotPair>;
  private readonly hip3: Map<string, { dexIndex: number; index: number; szDecimals: number }>;

  constructor(opts: {
    perps: PerpAsset[];
    spotPairs: SpotPair[];
    /** dex name -> its position in `perpDexs` */
    perpDexs?: { name: string }[];
    /** per-dex universe entries for HIP-3 markets */
    hip3Universes?: { dex: string; perps: PerpAsset[] }[];
  }) {
    this.perps = new Map();
    opts.perps.forEach((asset, index) => {
      this.perps.set(asset.name, { index, asset });
    });

    this.spot = new Map();
    this.spotByIndex = new Map();
    for (const pair of opts.spotPairs) {
      this.spot.set(pair.name, { index: pair.index, pair });
      this.spotByIndex.set(pair.index, pair);
    }

    this.hip3 = new Map();
    const dexIndexByName = new Map((opts.perpDexs ?? []).map((d, i) => [d.name, i]));
    for (const uni of opts.hip3Universes ?? []) {
      const dexIndex = dexIndexByName.get(uni.dex);
      if (dexIndex === undefined) continue;
      uni.perps.forEach((asset, index) => {
        this.hip3.set(`${uni.dex}:${asset.name}`, { dexIndex, index, szDecimals: asset.szDecimals });
      });
    }
  }

  /** Resolve a perp symbol, case-insensitively. `BTC` and `btc` both work. */
  resolvePerp(symbol: string): ResolvedAsset {
    const found = this.lookupPerp(symbol);
    if (found === undefined) {
      throw new UsageError("UNKNOWN_ASSET", `unknown perpetual market: ${symbol}`, { symbol, kind: "perp" });
    }
    return {
      kind: "perp",
      assetId: PERP_OFFSET + found.index,
      symbol: found.asset.name,
      szDecimals: found.asset.szDecimals,
    };
  }

  /**
   * Resolve a spot pair. Accepts the canonical `BASE/QUOTE` name and the
   * `@<index>` form used for non-canonical pairs. Asset id is `10000 + index`.
   */
  resolveSpot(pair: string): ResolvedAsset {
    const byName = this.spot.get(pair);
    if (byName !== undefined) {
      return {
        kind: "spot",
        assetId: SPOT_OFFSET + byName.index,
        symbol: byName.pair.name,
        szDecimals: 0,
      };
    }
    const idxMatch = /^@(\d+)$/.exec(pair);
    if (idxMatch?.[1] !== undefined) {
      const idx = Number(idxMatch[1]);
      const byIndex = this.spotByIndex.get(idx);
      if (byIndex !== undefined) {
        return { kind: "spot", assetId: SPOT_OFFSET + idx, symbol: byIndex.name, szDecimals: 0 };
      }
    }
    throw new UsageError("UNKNOWN_ASSET", `unknown spot pair: ${pair}`, { symbol: pair, kind: "spot" });
  }

  /** Resolve a HIP-3 builder-perp named `dex:COIN`, e.g. `xyz:AAPL`. */
  resolveHip3(symbol: string): ResolvedAsset {
    const found = this.hip3.get(symbol);
    if (found === undefined) {
      throw new UsageError("UNKNOWN_ASSET", `unknown HIP-3 market: ${symbol}`, { symbol, kind: "hip3" });
    }
    return {
      kind: "hip3",
      assetId: HIP3_OFFSET + found.dexIndex * HIP3_DEX_STRIDE + found.index,
      symbol,
      szDecimals: found.szDecimals,
    };
  }

  /** Try perp, then HIP-3, then spot. Used when the user did not say which. */
  resolveAny(symbol: string): ResolvedAsset {
    const attempts: (() => ResolvedAsset)[] = [
      () => this.resolvePerp(symbol),
      () => this.resolveHip3(symbol),
      () => this.resolveSpot(symbol),
    ];
    for (const attempt of attempts) {
      try {
        return attempt();
      } catch {
        /* try the next product type */
      }
    }
    throw new UsageError("UNKNOWN_ASSET", `unknown market: ${symbol}`, { symbol });
  }

  allPerpSymbols(): string[] {
    return [...this.perps.values()].map((e) => e.asset.name);
  }

  /** True when the symbol is a spot pair. */
  isSpot(symbol: string): boolean {
    return this.spot.has(symbol) || /^@\d+$/.test(symbol);
  }

  private lookupPerp(symbol: string): { index: number; asset: PerpAsset } | undefined {
    const exact = this.perps.get(symbol);
    if (exact !== undefined) return exact;
    const upper = symbol.toUpperCase();
    return this.perps.get(upper);
  }
}
