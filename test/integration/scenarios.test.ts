import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/index.js";

/**
 * Scenario suite S1-S6.
 *
 * These drive the real `run()` entry point with real argv. Network calls hit the
 * live public read API (no credentials needed); anything that would sign is
 * forced through --dry-run or pointed at an isolated config dir, so no test can
 * ever place a real order.
 */

function capture(): {
  out: string[];
  err: string[];
  io: { stdout: (t: string) => void; stderr: (t: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) } };
}

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "hlcli-it-"));
}

const THROWAWAY_KEY = `0x${"3".repeat(64)}`;
const THROWAWAY_ACCOUNT = "0x1111111111111111111111111111111111111111";
const THROWAWAY_AGENT = privateKeyToAccount(THROWAWAY_KEY as `0x${string}`).address.toLowerCase();

describe("S1 - happy path: market data for a selected market", () => {
  it("returns a BTC price with no credentials configured at all", async () => {
    const { out, err, io } = capture();
    const emptyDir = join(sandbox(), "never-created");
    const code = await run(["--config-dir", emptyDir, "market", "mids", "BTC"], io);
    expect(code).toBe(0);
    expect(err).toHaveLength(0);
    const parsed = JSON.parse(out.join("")) as Record<string, string>;
    expect(parsed.BTC).toMatch(/^\d+(\.\d+)?$/);
  });

  it("resolves a spot pair by its BASE/QUOTE name", async () => {
    const { out, err, io } = capture();
    const code = await run(
      ["--config-dir", join(sandbox(), "x"), "market", "mids", "PURR/USDC"],
      io,
    );
    expect(err).toHaveLength(0);
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toHaveProperty("PURR/USDC");
  });

  it("reports exchange status", async () => {
    const { out, io } = capture();
    const code = await run(["--config-dir", join(sandbox(), "x"), "market", "status"], io);
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ network: "mainnet" });
  });

  it("lists perpetual markets with their resolved indices", async () => {
    const { out, io } = capture();
    const code = await run(
      ["--config-dir", join(sandbox(), "x"), "market", "list", "--limit", "3"],
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      count: number;
      total: number;
      page: { limit: number; hasMore: boolean };
      markets: { symbol: string; index: number; midPx: string | null; dayNtlVlm: string | null }[];
    };
    expect(parsed.count).toBe(3);
    expect(parsed.total).toBeGreaterThan(3);
    expect(parsed.page).toMatchObject({ limit: 3, hasMore: true });
    expect(parsed.markets[0]?.midPx).toMatch(/^\d+(\.\d+)?$/);
    expect(parsed.markets[0]?.dayNtlVlm).toMatch(/^\d+(\.\d+)?$/);
  });

  it("lists spot labels and prices and resolves them back to canonical symbols", async () => {
    const cap = capture();
    const code = await run(
      ["--config-dir", join(sandbox(), "x"), "market", "list", "--spot", "--limit", "3"],
      cap.io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join("")) as {
      pairs: { symbol: string; pair: string; midPx: string | null }[];
    };
    expect(parsed.pairs[0]?.pair).toMatch(/^.+\/.+$/);
    expect(parsed.pairs[0]?.midPx === null || typeof parsed.pairs[0]?.midPx === "string").toBe(
      true,
    );
  });

  it("keeps default candle output bounded", async () => {
    const cap = capture();
    const code = await run(
      ["--config-dir", join(sandbox(), "x"), "market", "candles", "BTC"],
      cap.io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join("")) as { candles: unknown[]; page: { limit: number } };
    expect(parsed.candles.length).toBeLessThanOrEqual(20);
    expect(parsed.page.limit).toBe(20);
  });

  it("discovers a HIP-3 DEX, lists its markets, and returns a ticker", async () => {
    const dir = join(sandbox(), "x");
    const dexes = capture();
    expect(await run(["--config-dir", dir, "market", "dexs"], dexes.io)).toBe(0);
    const parsedDexes = JSON.parse(dexes.out.join("")) as {
      dexs: { name: string; kind: string }[];
    };
    const dex = parsedDexes.dexs.find((candidate) => candidate.kind === "hip3");
    expect(dex).toBeDefined();
    const listings = capture();
    expect(
      await run(
        ["--config-dir", dir, "market", "list", "--dex", dex?.name ?? "", "--limit", "1"],
        listings.io,
      ),
    ).toBe(0);
    const listed = JSON.parse(listings.out.join("")) as {
      markets: { symbol: string; kind: string }[];
    };
    const symbol = listed.markets[0]?.symbol;
    expect(symbol).toContain(":");
    expect(listed.markets[0]?.kind).toBe("hip3");
    const ticker = capture();
    expect(await run(["--config-dir", dir, "market", "ticker", symbol ?? ""], ticker.io)).toBe(0);
    expect(JSON.parse(ticker.out.join(""))).toMatchObject({ symbol, kind: "hip3" });
  });
});

describe("S2 - one-time secure setup, then reuse without prompting", () => {
  beforeAll(() => {
    process.env.HLCLI_STORAGE_BACKEND = "file";
  });
  it("stores an encrypted key, keeps config key-free, and reuses it with stdin closed", async () => {
    const dir = sandbox();
    const cfg = join(dir, "cfg");
    const keyFile = join(dir, "agent.key");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(keyFile, THROWAWAY_KEY);
    chmodSync(keyFile, 0o600);

    const init = capture();
    const initCode = await run(
      [
        "--config-dir",
        cfg,
        "init",
        "--account",
        THROWAWAY_ACCOUNT,
        "--key-file",
        keyFile,
        "--network",
        "testnet",
      ],
      init.io,
    );
    expect(initCode).toBe(0);
    const initOut = JSON.parse(init.out.join("")) as {
      agentAddress: string;
      accountAddress: string;
    };
    expect(initOut.accountAddress).toBe(THROWAWAY_ACCOUNT);
    expect(initOut.agentAddress).toMatch(/^0x[0-9a-f]{40}$/);

    const configRaw = readFileSync(join(cfg, "config.json"), "utf8");
    expect(configRaw).not.toContain("33333333");
    expect(configRaw).not.toMatch(/privateKey/i);

    const sealed = readFileSync(join(cfg, "agent.key"), "utf8");
    expect(sealed).not.toContain("33333333");
    const box = JSON.parse(sealed) as { kdf: string; N: number };
    expect(box.kdf).toBe("scrypt");
    expect(box.N).toBe(131072);

    const show = capture();
    const showCode = await run(["--config-dir", cfg, "config", "show"], show.io);
    expect(showCode).toBe(0);
    expect(show.out.join("") + show.err.join("")).not.toContain("3333333333");
  });

  it("rejects a malformed private key at init with exit 2", async () => {
    const dir = sandbox();
    const bad = join(dir, "bad");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(bad, "0xnothex");
    const c = capture();
    const code = await run(
      ["--config-dir", join(dir, "c"), "init", "--account", THROWAWAY_ACCOUNT, "--key-file", bad],
      c.io,
    );
    expect(code).toBe(2);
    expect(JSON.parse(c.err.join(""))).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("rejects an API wallet address that does not match its private key", async () => {
    const dir = sandbox();
    const keyFile = join(dir, "agent.key");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(keyFile, THROWAWAY_KEY);
    chmodSync(keyFile, 0o600);

    const c = capture();
    const code = await run(
      [
        "--config-dir",
        join(dir, "cfg"),
        "init",
        "--account",
        THROWAWAY_ACCOUNT,
        "--agent-address",
        THROWAWAY_ACCOUNT,
        "--key-file",
        keyFile,
      ],
      c.io,
    );
    expect(code).toBe(2);
    expect(JSON.parse(c.err.join(""))).toMatchObject({
      error: {
        code: "INVALID_INPUT",
        message: "API wallet address does not match the address derived from its private key",
      },
    });
  });

  it("accepts the key from the environment instead of a file", async () => {
    const dir = sandbox();
    const c = capture();
    const prev = process.env.HLCLI_AGENT_PRIVATE_KEY;
    process.env.HLCLI_AGENT_PRIVATE_KEY = THROWAWAY_KEY;
    try {
      const code = await run(
        [
          "--config-dir",
          join(dir, "c"),
          "init",
          "--account",
          THROWAWAY_ACCOUNT,
          "--network",
          "testnet",
        ],
        c.io,
      );
      expect(code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.HLCLI_AGENT_PRIVATE_KEY;
      else process.env.HLCLI_AGENT_PRIVATE_KEY = prev;
    }
  });

  it("does not recommend or request agent approval for single-key trading", async () => {
    const dir = sandbox();
    const cfg = join(dir, "cfg");
    const keyFile = join(dir, "agent.key");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(keyFile, THROWAWAY_KEY);
    chmodSync(keyFile, 0o600);

    const init = capture();
    const initCode = await run(
      ["--config-dir", cfg, "init", "--account", THROWAWAY_AGENT, "--key-file", keyFile],
      init.io,
    );
    expect(initCode).toBe(0);
    expect(JSON.parse(init.out.join(""))).toMatchObject({
      accountAddress: THROWAWAY_AGENT,
      agentAddress: THROWAWAY_AGENT,
      nextStep: "single-key trading is configured; no agent approval is needed",
    });

    const approval = capture();
    const approvalCode = await run(["--config-dir", cfg, "agent", "approve"], approval.io);
    expect(approvalCode).toBe(2);
    expect(JSON.parse(approval.err.join(""))).toMatchObject({
      error: {
        code: "UNSUPPORTED",
        message:
          "the API wallet and account addresses match; single-key trading does not need agent approval",
      },
    });
  });
});

describe("S3 - edge cases produce exit 2 and a structured error", () => {
  const cases: { name: string; argv: string[]; code: string }[] = [
    { name: "unknown asset", argv: ["market", "mids", "NOTACOIN"], code: "UNKNOWN_ASSET" },
    {
      name: "negative size",
      argv: ["order", "place", "BTC", "--size", "-5", "--price", "1"],
      code: "INVALID_INPUT",
    },
    {
      name: "spot size exceeds base token precision",
      argv: ["order", "place", "@1", "--spot", "--size", "1.001", "--price", "1"],
      code: "INVALID_INPUT",
    },
    { name: "bad interval", argv: ["market", "candles", "BTC", "--interval", "7z"], code: "USAGE" },
    { name: "missing price", argv: ["order", "place", "BTC", "--size", "1"], code: "USAGE" },
    {
      name: "neither cross nor isolated",
      argv: ["margin", "leverage", "BTC", "10"],
      code: "USAGE",
    },
    { name: "modify with nothing to change", argv: ["order", "modify", "123"], code: "USAGE" },
  ];

  for (const c of cases) {
    it(`${c.name} -> exit 2 with code ${c.code}`, async () => {
      const cap = capture();
      const code = await run(["--config-dir", join(sandbox(), "cfg"), ...c.argv], cap.io);
      const raw = cap.err.join("");
      expect(raw.length).toBeGreaterThan(0);
      expect(code).toBe(2);
      expect(JSON.parse(raw)).toMatchObject({ error: { code: c.code } });
    });
  }

  it("reports NOT_CONFIGURED for account reads on an uninitialised dir", async () => {
    const cap = capture();
    const code = await run(["--config-dir", join(sandbox(), "nope"), "account", "state"], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.err.join(""))).toMatchObject({ error: { code: "NOT_CONFIGURED" } });
  });

  it("keeps stdout empty on every failure so JSON output is never corrupted", async () => {
    const cap = capture();
    await run(["--config-dir", join(sandbox(), "nope"), "market", "mids", "NOTACOIN"], cap.io);
    expect(cap.out).toHaveLength(0);
  });
});

describe("S4 - the read path never touches the credential store", () => {
  it("writes no files at all for a market data command", async () => {
    const dir = sandbox();
    const { readdirSync, existsSync } = await import("node:fs");
    const cfg = join(dir, "cfg");
    const cap = capture();
    const code = await run(["--config-dir", cfg, "market", "mids", "BTC"], cap.io);
    expect(code).toBe(0);
    expect(existsSync(cfg)).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("still fails clearly on the read path when the store is unconfigured", async () => {
    const cap = capture();
    const code = await run(["--config-dir", join(sandbox(), "x"), "account", "orders"], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.err.join(""))).toMatchObject({ error: { code: "NOT_CONFIGURED" } });
  });
});

describe("S5 - trading path signs correctly but --dry-run never posts", () => {
  async function initSandbox(): Promise<string> {
    const dir = sandbox();
    process.env.HLCLI_STORAGE_BACKEND = "file";
    const keyFile = join(dir, "k");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(keyFile, THROWAWAY_KEY);
    const cap = capture();
    await run(
      [
        "--config-dir",
        join(dir, "cfg"),
        "init",
        "--account",
        THROWAWAY_ACCOUNT,
        "--key-file",
        keyFile,
        "--network",
        "testnet",
      ],
      cap.io,
    );
    return join(dir, "cfg");
  }

  it("produces a signed order envelope with posted=false", async () => {
    const cfg = await initSandbox();
    const cap = capture();
    const code = await run(
      [
        "--config-dir",
        cfg,
        "--dry-run",
        "order",
        "place",
        "BTC",
        "--side",
        "buy",
        "--size",
        "0.01",
        "--price",
        "50000",
      ],
      cap.io,
    );
    expect(code).toBe(0);
    const out = JSON.parse(cap.out.join("")) as {
      dryRun: boolean;
      posted: boolean;
      envelope: {
        nonce: number;
        action: { type: string; orders: { a: number; p: string; r: boolean }[] };
        signature: { r: string; s: string; v: number };
      };
    };
    expect(out.dryRun).toBe(true);
    expect(out.posted).toBe(false);
    expect(out.envelope.action.type).toBe("order");
    expect(out.envelope.action.orders[0]?.a).toBe(0);
    expect(out.envelope.action.orders[0]?.p).toBe("50000");
    expect([27, 28]).toContain(out.envelope.signature.v);
    expect(out.envelope.nonce).toBeGreaterThan(1_700_000_000_000);
  });

  it("redacts the signature so a dry-run transcript is not replayable", async () => {
    const cfg = await initSandbox();
    const cap = capture();
    await run(
      [
        "--config-dir",
        cfg,
        "--dry-run",
        "order",
        "place",
        "BTC",
        "--size",
        "0.01",
        "--price",
        "50000",
      ],
      cap.io,
    );
    const out = JSON.parse(cap.out.join("")) as {
      envelope: { signature: { r: string; s: string } };
    };
    expect(out.envelope.signature.r.endsWith("...")).toBe(true);
    expect(out.envelope.signature.s.endsWith("...")).toBe(true);
  });

  it("omits the optional f flag on a cancel instead of sending false", async () => {
    const cfg = await initSandbox();
    const cap = capture();
    await run(["--config-dir", cfg, "--dry-run", "order", "cancel", "BTC", "12345"], cap.io);
    const out = JSON.parse(cap.out.join("")) as { envelope: { action: Record<string, unknown> } };
    expect("f" in out.envelope.action).toBe(false);
    expect(out.envelope.action.type).toBe("cancel");
  });

  it("includes f when --fast is requested", async () => {
    const cfg = await initSandbox();
    const cap = capture();
    await run(
      ["--config-dir", cfg, "--dry-run", "order", "cancel", "BTC", "12345", "--fast"],
      cap.io,
    );
    const out = JSON.parse(cap.out.join("")) as { envelope: { action: Record<string, unknown> } };
    expect(out.envelope.action.f).toBe(true);
  });

  it("refuses to sign when no key is configured", async () => {
    const cap = capture();
    const code = await run(
      [
        "--config-dir",
        join(sandbox(), "none"),
        "--dry-run",
        "order",
        "place",
        "BTC",
        "--size",
        "1",
        "--price",
        "1",
      ],
      cap.io,
    );
    expect(code).toBe(2);
    expect(JSON.parse(cap.err.join(""))).toMatchObject({ error: { code: "NOT_CONFIGURED" } });
  });
});

describe("S6 - no fund-movement command exists", () => {
  const BANNED = [
    "withdraw",
    "send",
    "transfer",
    "deposit",
    "delegate",
    "redeem",
    "bridge",
    "swap",
    "vault",
  ];

  it("exposes no command or subcommand named like a fund movement", async () => {
    const { buildProgram } = await import("../../src/index.js");
    const walk = (
      cmd: { commands: { name(): string; commands: unknown[] }[]; name(): string },
      acc: string[],
    ): void => {
      acc.push(cmd.name());
      for (const sub of cmd.commands) walk(sub as never, acc);
    };
    const names: string[] = [];
    walk(buildProgram() as never, names);
    for (const banned of BANNED) {
      expect(names.map((n) => n.toLowerCase())).not.toContain(banned);
    }
  });

  it("rejects a withdraw verb at the dispatcher with a JSON error, not plain text", async () => {
    const cap = capture();
    const code = await run(["withdraw", "--amount", "1"], cap.io);
    expect(code).toBe(2);
    // The documented contract is that EVERY error is JSON, including typos.
    expect(() => JSON.parse(cap.err.join(""))).not.toThrow();
    expect(JSON.parse(cap.err.join(""))).toMatchObject({ error: { code: "USAGE" } });
    expect(cap.err.join("")).toContain("unknown command");
  });

  it("never wires the user-signed fund actions into the exchange client", async () => {
    const { readFileSync: read } = await import("node:fs");
    const files = [
      "src/api/exchange.ts",
      "src/commands/order.ts",
      "src/commands/margin.ts",
      "src/commands/twap.ts",
    ];
    for (const f of files) {
      const body = read(new URL(`../../${f}`, import.meta.url), "utf8");
      for (const banned of [
        "usdSend",
        "spotSend",
        "withdraw3",
        "sendAsset",
        "usdClassTransfer",
        "vaultTransfer",
        "tokenDelegate",
        "cDeposit",
        "cWithdraw",
        "claimRewards",
      ]) {
        expect(body).not.toContain(banned);
      }
    }
  });
});

describe("output contract", () => {
  it("--quiet suppresses stdout entirely", async () => {
    const cap = capture();
    const code = await run(
      ["--config-dir", join(sandbox(), "x"), "--quiet", "market", "mids", "BTC"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(cap.out).toHaveLength(0);
  });

  it("--table renders tab-separated rows rather than JSON", async () => {
    const cap = capture();
    const code = await run(
      ["--config-dir", join(sandbox(), "x"), "--table", "market", "mids", "BTC"],
      cap.io,
    );
    expect(code).toBe(0);
    const text = cap.out.join("");
    expect(text).toContain("coin");
    expect(text).toContain("BTC");
    expect(() => JSON.parse(text)).toThrow();
  });

  it("emits JSON for an unknown subcommand rather than commander plain text", async () => {
    const cap = capture();
    const code = await run(["market", "midz"], cap.io);
    expect(code).toBe(2);
    expect(() => JSON.parse(cap.err.join(""))).not.toThrow();
  });

  it("emits JSON for an unknown option rather than commander plain text", async () => {
    const cap = capture();
    const code = await run(["market", "mids", "--nope"], cap.io);
    expect(code).toBe(2);
    expect(() => JSON.parse(cap.err.join(""))).not.toThrow();
  });

  it("keeps human help text for --help", async () => {
    const cap = capture();
    expect(await run(["order", "--help"], cap.io)).toBe(0);
    expect(cap.out.join("")).toContain("Usage: hyperliquid order");
  });

  it("--help exits 0", async () => {
    const cap = capture();
    expect(await run(["--help"], cap.io)).toBe(0);
    expect(cap.out.join("")).toContain("Usage: hyperliquid");
  });
});
