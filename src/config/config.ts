import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_SCHEMA_VERSION = 1;

export const networkSchema = z.enum(["mainnet", "testnet"]);
export type Network = z.infer<typeof networkSchema>;

export const storageBackendSchema = z.enum(["keychain", "file", "env"]);
export type StorageBackend = z.infer<typeof storageBackendSchema>;

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x-prefixed hex address")
  .transform((s) => s.toLowerCase());

/**
 * Non-secret configuration only. The agent PRIVATE KEY is never stored here -
 * it lives in the OS keychain or an encrypted file under the same config dir.
 */
export const configSchema = z.object({
  version: z.literal(CONFIG_SCHEMA_VERSION),
  network: networkSchema,
  /** Whose positions/balance this CLI acts on. Public; not derivable from the agent key. */
  accountAddress: addressSchema,
  /** Derived from the stored private key. Public. Never used as `user` for reads. */
  agentAddress: addressSchema,
  agentName: z.string().min(1).max(64).optional(),
  storageBackend: storageBackendSchema,
});
export type HlConfig = z.infer<typeof configSchema>;

/**
 * Resolve the config directory.
 * `HLCLI_CONFIG_DIR` wins so agents and CI can be fully isolated from the
 * user's real trading credentials. Otherwise follow XDG.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HLCLI_CONFIG_DIR;
  if (override !== undefined && override.length > 0) return override;
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "hyperliquid");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

export function keystorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "agent.key");
}
