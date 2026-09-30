import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { getMeta, getPerpDexs, getSpotMeta, type InfoOptions, type PerpDex } from "../api/info.js";
import {
  AssetResolver,
  HIP3_DEX_STRIDE,
  HIP3_OFFSET,
  type PerpAsset,
  type ResolvedAsset,
  type SpotPair,
} from "../assets/resolve.js";
import { configDir, configSchema, type HlConfig, type Network } from "../config/config.js";
import { NotConfiguredError, UsageError } from "../errors.js";
import { type LoadedSecret, loadKey } from "../storage/keystore.js";

export interface GlobalFlags {
  testnet: boolean;
  dryRun: boolean;
  table: boolean;
  quiet: boolean;
  full: boolean;
  configDir?: string | undefined;
  env: NodeJS.ProcessEnv;
}

export class Context {
  readonly flags: GlobalFlags;
  private cfg: HlConfig | null = null;
  private resolver: AssetResolver | null = null;
  private dexList: PerpDex[] | null = null;
  private readonly dexMetas = new Map<string, PerpAsset[]>();

  constructor(flags: GlobalFlags) {
    this.flags = flags;
  }

  /**
   * The explicit --config-dir flag wins over the environment. Previously the
   * flag was parsed but ignored, so `hyperliquid --config-dir X ...` silently
   * read and wrote the real user config instead of the isolated one requested.
   */
  private dir(): string {
    const flag = this.flags.configDir;
    return flag !== undefined && flag.length > 0 ? flag : configDir(this.flags.env);
  }

  get infoOpts(): InfoOptions {
    const env: { testnet: boolean; fetchImpl?: typeof fetch | undefined } = {
      testnet: this.flags.testnet,
    };
    return env;
  }

  /**
   * Read persisted config. Only call this from commands that genuinely need the
   * account identity; market-data commands must never reach this.
   */
  async config(): Promise<HlConfig> {
    if (this.cfg !== null) return this.cfg;
    const { readFileSync } = await import("node:fs");
    let raw: string;
    try {
      raw = readFileSync(join(this.dir(), "config.json"), "utf8");
    } catch {
      throw new NotConfiguredError(
        "not configured; run `hyperliquid init` once, or pass --config-dir pointing at an initialised directory",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UsageError(
        "INVALID_INPUT",
        `config file is not valid JSON: ${join(this.dir(), "config.json")}`,
      );
    }
    const result = configSchema.safeParse(parsed);
    if (!result.success) {
      throw new UsageError(
        "INVALID_INPUT",
        `config file failed validation: ${join(this.dir(), "config.json")}`,
        {
          issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        },
      );
    }
    this.cfg = result.data;
    return this.cfg;
  }

  async hasConfig(): Promise<boolean> {
    try {
      await this.config();
      return true;
    } catch {
      return false;
    }
  }

  /** The signing key. NEVER call this on a read-only code path. */
  async signingKey(): Promise<LoadedSecret> {
    return loadKey(this.flags.env);
  }

  async wallet() {
    const { privateKey } = await this.signingKey();
    return privateKeyToAccount(privateKey);
  }

  /**
   * Build the symbol resolver from live metadata.
   * Resolution NEVER consults allMids keys - see assets/resolve.ts for why.
   */
  async assets(): Promise<AssetResolver> {
    if (this.resolver !== null) return this.resolver;
    const perps: PerpAsset[] = (await getMeta(this.infoOpts)).universe;
    const spotMeta = await getSpotMeta(this.infoOpts);
    const spotPairs: SpotPair[] = spotMeta.universe;
    this.resolver = new AssetResolver({ perps, spotPairs, spotTokens: spotMeta.tokens });
    return this.resolver;
  }

  async perpDexes(): Promise<PerpDex[]> {
    if (this.dexList !== null) return this.dexList;
    this.dexList = await getPerpDexs(this.infoOpts);
    return this.dexList;
  }

  async resolveDexName(requested: string): Promise<string> {
    if (requested === "" || requested.toLowerCase() === "primary") return "";
    const dexes = await this.perpDexes();
    const dex = dexes.find(
      (candidate) => candidate?.name.toLowerCase() === requested.toLowerCase(),
    );
    if (dex?.name === undefined) {
      throw new UsageError("UNKNOWN_ASSET", `unknown perpetual DEX: ${requested}`, {
        dex: requested,
      });
    }
    return dex.name;
  }

  /** Resolve main DEX, spot, or builder perp symbols without loading every DEX universe. */
  async resolveAny(symbol: string): Promise<ResolvedAsset> {
    const resolver = await this.assets();
    try {
      return resolver.resolveAny(symbol);
    } catch (err) {
      if (!symbol.includes(":")) throw err;
      const separator = symbol.indexOf(":");
      const requestedDex = symbol.slice(0, separator);
      const dexes = await this.perpDexes();
      const dexIndex = dexes.findIndex(
        (dex) => dex?.name.toLowerCase() === requestedDex.toLowerCase(),
      );
      const dex = dexes[dexIndex];
      if (dexIndex < 1 || dex?.name === undefined) throw err;

      let universe = this.dexMetas.get(dex.name);
      if (universe === undefined) {
        universe = (await getMeta(this.infoOpts, dex.name)).universe;
        this.dexMetas.set(dex.name, universe);
      }
      const assetIndex = universe.findIndex((asset) => {
        const canonical = asset.name.includes(":") ? asset.name : `${dex.name}:${asset.name}`;
        return canonical.toUpperCase() === symbol.toUpperCase();
      });
      const asset = universe[assetIndex];
      if (assetIndex < 0 || asset === undefined) throw err;
      const canonical = asset.name.includes(":") ? asset.name : `${dex.name}:${asset.name}`;
      return {
        kind: "hip3",
        assetId: HIP3_OFFSET + dexIndex * HIP3_DEX_STRIDE + assetIndex,
        symbol: canonical,
        szDecimals: asset.szDecimals,
        displayName: `${canonical} perpetual`,
        dex: dex.name,
        ...(dex.fullName === undefined ? {} : { dexFullName: dex.fullName }),
      };
    }
  }

  async resolveSpot(symbol: string): Promise<ResolvedAsset> {
    return (await this.assets()).resolveSpot(symbol);
  }

  async network(): Promise<Network> {
    if (await this.hasConfig()) return (await this.config()).network;
    return this.flags.testnet ? "testnet" : "mainnet";
  }

  paths(): { dir: string; config: string; keystore: string } {
    const dir = this.dir();
    return { dir, config: join(dir, "config.json"), keystore: join(dir, "agent.key") };
  }
}

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x-prefixed hex address")
  .transform((s) => s.toLowerCase());
