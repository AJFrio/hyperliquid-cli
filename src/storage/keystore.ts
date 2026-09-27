import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config/config.js";
import { NotConfiguredError, UsageError } from "../errors.js";
import { open_, readFileOrNull, seal, writeFileAtomic } from "./secretbox.js";

export const ENV_AGENT_KEY = "HLCLI_AGENT_PRIVATE_KEY";
export const ENV_PASSPHRASE = "HLCLI_KEYSTORE_PASSPHRASE";
const KEYCHAIN_SERVICE = "hyperliquid-cli";
/**
 * The keychain account is namespaced by a digest of the config directory.
 * A single fixed account name meant every config dir shared one keychain slot,
 * so `--config-dir` isolation leaked: a key saved in one sandbox was readable
 * from every other, including the default user location.
 */
const KEYCHAIN_ACCOUNT_BASE = "agent-private-key";

function keychainAccount(env: NodeJS.ProcessEnv): string {
  const digest = createHash("sha256").update(configDir(env)).digest("hex").slice(0, 16);
  return `${KEYCHAIN_ACCOUNT_BASE}-${digest}`;
}
const SECRET_FILE = "agent.key";
const MACHINE_KEY_FILE = "agent.mk";

export type KeySource = "env" | "keychain" | "file";

export interface LoadedSecret {
  privateKey: `0x${string}`;
  source: KeySource;
  masked: string;
}

const HEX64 = /^0x[0-9a-fA-F]{64}$/;

export function maskKey(key: string): string {
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function assertKey(value: string, origin: string): `0x${string}` {
  const trimmed = value.trim();
  if (!HEX64.test(trimmed)) {
    throw new UsageError(
      "INVALID_INPUT",
      `${origin} must be a 32-byte 0x-prefixed hex private key (66 chars); got ${trimmed.length} chars`,
    );
  }
  return trimmed.toLowerCase() as `0x${string}`;
}

/**
 * The machine key is a random 32-byte file that keys the at-rest encryption.
 * It protects the private key from accidental disclosure (backups, stray greps,
 * a synced config dir). It does NOT protect against code already running as this
 * user - that is precisely why the OS keychain is the primary backend and this is
 * only the fallback for headless environments.
 */
function machineKeyFor(dir: string): string {
  const path = join(dir, MACHINE_KEY_FILE);
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const key = randomBytes(32).toString("hex");
  writeFileAtomic(path, `${key}\n`);
  return key;
}

function passphraseFor(dir: string, env: NodeJS.ProcessEnv): string {
  const explicit = env[ENV_PASSPHRASE];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return machineKeyFor(dir);
}

function keychainAvailable(env: NodeJS.ProcessEnv): boolean {
  return env.HLCLI_STORAGE_BACKEND !== "file";
}

async function keychainGet(account: string): Promise<string | null> {
  try {
    const mod = await import("@github/keytar");
    return await mod.getPassword(KEYCHAIN_SERVICE, account);
  } catch {
    return null;
  }
}

async function keychainSet(account: string, secret: string): Promise<boolean> {
  try {
    const mod = await import("@github/keytar");
    await mod.setPassword(KEYCHAIN_SERVICE, account, secret);
    return true;
  } catch {
    return false;
  }
}

export async function saveKey(
  privateKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KeySource> {
  const key = assertKey(privateKey, "private key");
  const dir = configDir(env);
  const envIsFileOnly = env.HLCLI_STORAGE_BACKEND === "file";

  if (!envIsFileOnly) {
    if (await keychainSet(keychainAccount(env), key)) {
      // The OS keychain is the primary backend. Remove any encrypted fallback
      // left by an earlier headless setup so we keep only one on-device copy.
      for (const name of [SECRET_FILE, MACHINE_KEY_FILE]) {
        try {
          rmSync(join(dir, name), { force: true });
        } catch {
          /* best effort cleanup */
        }
      }
      return "keychain";
    }
  }
  writeFileAtomic(join(dir, SECRET_FILE), seal(key, passphraseFor(dir, env)));
  return "file";
}

export async function loadKey(env: NodeJS.ProcessEnv = process.env): Promise<LoadedSecret> {
  const fromEnv = env[ENV_AGENT_KEY];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const key = assertKey(fromEnv, ENV_AGENT_KEY);
    return { privateKey: key, source: "env", masked: maskKey(key) };
  }
  const dir = configDir(env);

  if (keychainAvailable(env)) {
    const fromKeychain = await keychainGet(keychainAccount(env));
    if (fromKeychain !== null && fromKeychain.length > 0) {
      const key = assertKey(fromKeychain, "stored keychain key");
      return { privateKey: key, source: "keychain", masked: maskKey(key) };
    }
  }

  const sealed = readFileOrNull(join(dir, SECRET_FILE));
  if (sealed !== null) {
    try {
      const key = assertKey(open_(sealed, passphraseFor(dir, env)), "stored key");
      return { privateKey: key, source: "file", masked: maskKey(key) };
    } catch (err) {
      if (err instanceof UsageError) throw err;
      throw new UsageError(
        "INVALID_INPUT",
        "stored key could not be decrypted; the keystore passphrase or machine key is wrong",
      );
    }
  }

  throw new NotConfiguredError(
    `no agent key configured; run \`hyperliquid init\` once, or set ${ENV_AGENT_KEY}`,
  );
}

export async function clearKey(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = configDir(env);
  for (const name of [SECRET_FILE, MACHINE_KEY_FILE]) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      /* best effort */
    }
  }
  try {
    const mod = await import("@github/keytar");
    await mod.deletePassword(KEYCHAIN_SERVICE, keychainAccount(env));
  } catch {
    /* best effort */
  }
}
