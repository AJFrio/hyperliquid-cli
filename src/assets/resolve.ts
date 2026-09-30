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

export interface SpotToken {
  index: number;
  szDecimals: number;
  name?: string;
  fullName?: string | null | undefined;
}

export type AssetKind = "perp" | "spot" | "hip3";

export interface ResolvedAsset {
  kind: AssetKind;
  assetId: number;
  symbol: string;
  szDecimals: number;
  displayName?: string;
  fullName?: string | null | undefined;
  dex?: string;
  dexFullName?: string;
}

export class AssetResolver {
  private readonly perps: Map<string, { index: number; asset: PerpAsset }>;
  private readonly spot: Map<string, { index: number; pair: SpotPair }>;
  private readonly spotByIndex: Map<number, SpotPair>;
  private readonly spotTokens: Map<number, SpotToken>;
  private readonly hip3: Map<
    string,
    {
      symbol: string;
      dex: string;
      dexFullName?: string;
      dexIndex: number;
      index: number;
      szDecimals: number;
    }
  >;

  constructor(opts: {
    perps: PerpAsset[];
    spotPairs: SpotPair[];
    spotTokens?: SpotToken[];
    /** dex name -> its position in `perpDexs` */
    perpDexs?: { name: string; fullName?: string | undefined }[];
    /** per-dex universe entries for HIP-3 markets */
    hip3Universes?: { dex: string; perps: PerpAsset[] }[];
  }) {
    this.perps = new Map();
    opts.perps.forEach((asset, index) => {
      this.perps.set(asset.name, { index, asset });
    });

    this.spot = new Map();
    this.spotByIndex = new Map();
    this.spotTokens = new Map((opts.spotTokens ?? []).map((token) => [token.index, token]));
    for (const pair of opts.spotPairs) {
      this.spot.set(pair.name, { index: pair.index, pair });
      this.spotByIndex.set(pair.index, pair);
    }

    this.hip3 = new Map();
    const dexIndexByName = new Map(
      (opts.perpDexs ?? []).map((d, i) => [d.name, { index: i, fullName: d.fullName }]),
    );
    for (const uni of opts.hip3Universes ?? []) {
      const dex = dexIndexByName.get(uni.dex);
      if (dex === undefined) continue;
      uni.perps.forEach((asset, index) => {
        const symbol = asset.name.includes(":") ? asset.name : `${uni.dex}:${asset.name}`;
        this.hip3.set(symbol.toUpperCase(), {
          symbol,
          dex: uni.dex,
          ...(dex.fullName === undefined ? {} : { dexFullName: dex.fullName }),
          dexIndex: dex.index,
          index,
          szDecimals: asset.szDecimals,
        });
      });
    }
  }

  /** Resolve a perp symbol, case-insensitively. `BTC` and `btc` both work. */
  resolvePerp(symbol: string): ResolvedAsset {
    const found = this.lookupPerp(symbol);
    if (found === undefined) {
      throw new UsageError("UNKNOWN_ASSET", `unknown perpetual market: ${symbol}`, {
        symbol,
        kind: "perp",
      });
    }
    return {
      kind: "perp",
      assetId: PERP_OFFSET + found.index,
      symbol: found.asset.name,
      szDecimals: found.asset.szDecimals,
      displayName: `${found.asset.name} perpetual`,
    };
  }

  /**
   * Resolve a spot pair. Accepts the canonical `BASE/QUOTE` name and the
   * `@<index>` form used for non-canonical pairs. Asset id is `10000 + index`.
   */
  resolveSpot(spotName: string): ResolvedAsset {
    const byName = this.spot.get(spotName);
    if (byName !== undefined) {
      return {
        kind: "spot",
        assetId: SPOT_OFFSET + byName.index,
        symbol: byName.pair.name,
        szDecimals: this.spotTokens.get(byName.pair.tokens[0])?.szDecimals ?? 0,
        displayName: this.spotDisplayName(byName.pair),
        fullName: this.spotTokens.get(byName.pair.tokens[0])?.fullName,
      };
    }
    const displayMatches = [...this.spot.values()].filter(
      ({ pair }) => this.spotDisplayName(pair).toUpperCase() === spotName.toUpperCase(),
    );
    if (displayMatches.length > 1) {
      throw new UsageError(
        "INVALID_INPUT",
        `ambiguous spot pair label: ${spotName}; use @<index>`,
        {
          symbol: spotName,
          candidates: displayMatches.map(({ pair }) => pair.name),
        },
      );
    }
    const byDisplayName = displayMatches[0];
    if (byDisplayName !== undefined) {
      return {
        kind: "spot",
        assetId: SPOT_OFFSET + byDisplayName.index,
        symbol: byDisplayName.pair.name,
        szDecimals: this.spotTokens.get(byDisplayName.pair.tokens[0])?.szDecimals ?? 0,
        displayName: this.spotDisplayName(byDisplayName.pair),
        fullName: this.spotTokens.get(byDisplayName.pair.tokens[0])?.fullName,
      };
    }
    const idxMatch = /^@(\d+)$/.exec(spotName);
    if (idxMatch?.[1] !== undefined) {
      const idx = Number(idxMatch[1]);
      const byIndex = this.spotByIndex.get(idx);
      if (byIndex !== undefined) {
        return {
          kind: "spot",
          assetId: SPOT_OFFSET + idx,
          symbol: byIndex.name,
          szDecimals: this.spotTokens.get(byIndex.tokens[0])?.szDecimals ?? 0,
          displayName: this.spotDisplayName(byIndex),
          fullName: this.spotTokens.get(byIndex.tokens[0])?.fullName,
        };
      }
    }
    throw new UsageError("UNKNOWN_ASSET", `unknown spot pair: ${spotName}`, {
      symbol: spotName,
      kind: "spot",
    });
  }

  /** Resolve a HIP-3 builder-perp named `dex:COIN`, e.g. `xyz:AAPL`. */
  resolveHip3(symbol: string): ResolvedAsset {
    const found = this.hip3.get(symbol.toUpperCase());
    if (found === undefined) {
      throw new UsageError("UNKNOWN_ASSET", `unknown HIP-3 market: ${symbol}`, {
        symbol,
        kind: "hip3",
      });
    }
    return {
      kind: "hip3",
      assetId: HIP3_OFFSET + found.dexIndex * HIP3_DEX_STRIDE + found.index,
      symbol: found.symbol,
      szDecimals: found.szDecimals,
      displayName: `${found.symbol} perpetual`,
      dex: found.dex,
      ...(found.dexFullName === undefined ? {} : { dexFullName: found.dexFullName }),
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

  private spotDisplayName(pair: SpotPair): string {
    const base = this.spotTokens.get(pair.tokens[0])?.name;
    const quote = this.spotTokens.get(pair.tokens[1])?.name;
    return base !== undefined && quote !== undefined ? `${base}/${quote}` : pair.name;
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
