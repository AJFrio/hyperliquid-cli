import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotConfiguredError } from "../../src/errors.js";
import { configDir } from "../../src/config/config.js";
import { clearKey, loadKey, saveKey, type LoadedSecret } from "../../src/storage/keystore.js";

const TEST_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";

let dir: string;
const env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hlcli-store-"));
  env["HLCLI_CONFIG_DIR"] = dir;
  delete env["HLCLI_AGENT_PRIVATE_KEY"];
  delete env["HLCLI_KEYSTORE_PASSPHRASE"];
});

afterEach(async () => {
  await clearKey();
});

// Force the encrypted-file backend so the suite never writes to the real OS
// keychain of whoever is running it.
function fileEnv(): NodeJS.ProcessEnv {
  return { ...env, HLCLI_STORAGE_BACKEND: "file" };
}

describe("config dir isolation", () => {
  it("HLCLI_CONFIG_DIR fully overrides the default location", () => {
    expect(configDir(env)).toBe(dir);
  });

  it("falls back to XDG_CONFIG_HOME then ~/.config when unset", () => {
    const noOverride: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: "/tmp/xdg" };
    expect(configDir(noOverride)).toBe("/tmp/xdg/hyperliquid");
  });
});

describe("key precedence: env beats stored key", () => {
  it("returns the env key without touching disk or the keychain", async () => {
    env["HLCLI_AGENT_PRIVATE_KEY"] = TEST_KEY;
    const loaded = await loadKey(fileEnv());
    expect(loaded.source).toBe("env");
    expect(loaded.privateKey).toBe(TEST_KEY);
    expect(loaded.source === "env" && loaded.masked).toBe(`0x2222...2222`);
  });

  it("raises a structured NOT_CONFIGURED error when nothing is available", async () => {
    let caught: unknown;
    try {
      await loadKey(fileEnv());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotConfiguredError);
    expect((caught as NotConfiguredError).code).toBe("NOT_CONFIGURED");
    expect((caught as NotConfiguredError).exitCode).toBe(2);
    expect((caught as NotConfiguredError).message).toMatch(/init/);
  });
});

describe("encrypted file backend", () => {
  it("round-trips a key through the encrypted store", async () => {
    await saveKey(TEST_KEY, fileEnv());
    const loaded = await loadKey(fileEnv());
    expect(loaded.source).toBe("file");
    expect(loaded.privateKey).toBe(TEST_KEY);
  });

  it("never stores the key in plaintext on disk", async () => {
    saveKey(TEST_KEY, fileEnv());
    const raw = readFileSync(join(dir, "agent.key"), "utf8");
    expect(raw).not.toContain("2222222222222222222222222222222222222222222222222222222222222222");
  });

  it("records the scrypt parameters so the cost factor cannot silently regress", async () => {
    saveKey(TEST_KEY, fileEnv());
    const parsed = JSON.parse(readFileSync(join(dir, "agent.key"), "utf8")) as { kdf: string; N: number };
    expect(parsed.kdf).toBe("scrypt");
    expect(parsed.N).toBe(131072);
  });

  it("creates the secret file with owner-only permissions", async () => {
    saveKey(TEST_KEY, fileEnv());
    const mode = statSync(join(dir, "agent.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("produces different ciphertext for the same key because the salt is random", async () => {
    await saveKey(TEST_KEY, fileEnv());
    const first = readFileSync(join(dir, "agent.key"), "utf8");
    await saveKey(TEST_KEY, fileEnv());
    const second = readFileSync(join(dir, "agent.key"), "utf8");
    expect(first).not.toBe(second);
  });

  it("rejects a tampered ciphertext rather than returning garbage", async () => {
    await saveKey(TEST_KEY, fileEnv());
    const path = join(dir, "agent.key");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { ct: string };
    parsed.ct = parsed.ct.replace(/^../, (m) => (m === "00" ? "ff" : "00"));
    writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 });
    await expect(loadKey(fileEnv())).rejects.toThrow();
  });

  it("round-trips when a passphrase is supplied explicitly", async () => {
    const withPass: NodeJS.ProcessEnv = { ...fileEnv(), HLCLI_KEYSTORE_PASSPHRASE: "correct horse battery staple" };
    await saveKey(TEST_KEY, withPass);
    expect((await loadKey(withPass)).privateKey).toBe(TEST_KEY);
  });

  it("fails to decrypt with the wrong passphrase instead of yielding a wrong key", async () => {
    await saveKey(TEST_KEY, { ...fileEnv(), HLCLI_KEYSTORE_PASSPHRASE: "right" });
    await expect(loadKey({ ...fileEnv(), HLCLI_KEYSTORE_PASSPHRASE: "wrong" })).rejects.toThrow();
  });
});

describe("secret hygiene", () => {
  it("masked form never contains more than the first and last 4 hex chars", async () => {
    await saveKey(TEST_KEY, fileEnv());
    const loaded: LoadedSecret = await loadKey(fileEnv());
    expect(loaded.masked).toBe("0x2222...2222");
    expect(loaded.masked).not.toContain(TEST_KEY.slice(4, 60));
  });

  it("clearKey removes the stored key and makes it unresolvable", async () => {
    await saveKey(TEST_KEY, fileEnv());
    await clearKey(fileEnv());
    await expect(loadKey(fileEnv())).rejects.toThrow(NotConfiguredError);
  });
});
