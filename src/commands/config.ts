import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { approveAgentAction, signAndSendUserSigned, ApproveAgentTypes } from "../api/exchange.js";
import { emitSuccess, type OutputOptions } from "../cli/output.js";
import type { Context } from "../cli/context.js";
import { CONFIG_SCHEMA_VERSION, type Network } from "../config/config.js";
import { UsageError } from "../errors.js";
import { clearKey, saveKey } from "../storage/keystore.js";
import { writeFileAtomic } from "../storage/secretbox.js";
import { addressSchema } from "../cli/context.js";
import { z } from "zod";

export const initOptionsSchema = z.object({
  accountAddress: addressSchema,
  privateKey: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "private key must be 0x + 64 hex chars")
    .transform((s) => s.toLowerCase() as `0x${string}`),
  network: z.enum(["mainnet", "testnet"]),
  agentName: z.string().min(1).max(64).optional(),
});

/**
 * One-time setup. Stores the agent signing key and the account address.
 *
 * The account address is the PUBLIC address whose positions this key trades and
 * is NOT derivable from the private key, which is why both are collected.
 */
export async function initCmd(
  ctx: Context,
  input: { accountAddress: string; privateKey: string; network: Network; agentName?: string | undefined },
  out: OutputOptions,
): Promise<number> {
  const parsed = initOptionsSchema.safeParse(input);
  if (!parsed.success) {
    throw new UsageError("INVALID_INPUT", "invalid init arguments", {
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const { accountAddress, privateKey, network, agentName } = parsed.data;

  const wallet = privateKeyToAccount(privateKey);
  const agentAddress = wallet.address.toLowerCase();

  if (accountAddress === agentAddress) {
    // Legitimate for single-key trading, but the two-wallet model is the norm;
    // surface it so the user is not surprised by role confusion later.
    process.stderr.write(
      "# note: account address equals the agent address (single-key trading). Read commands will use it directly.\n",
    );
  }

  const backend = await saveKey(privateKey, ctx.flags.env);
  const config = {
    version: CONFIG_SCHEMA_VERSION as 1,
    network,
    accountAddress,
    agentAddress,
    ...(agentName === undefined ? {} : { agentName }),
    storageBackend: backend,
  } as const;
  writeFileAtomic(ctx.paths().config, `${JSON.stringify(config, null, 2)}\n`, 0o600);

  emitSuccess(
    {
      configured: true,
      network,
      accountAddress,
      agentAddress,
      storageBackend: backend,
      configFile: ctx.paths().config,
      nextStep:
        network === "mainnet"
          ? "register this agent with the account: `hyperliquid agent approve` (needs the MASTER key, passed per-invocation, never stored)"
          : "testnet only - no real funds at risk",
    },
    out,
  );
  return 0;
}

export async function configShowCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const cfg = await ctx.config();
  emitSuccess(
    {
      ...cfg,
      configFile: ctx.paths().config,
      keystoreFile: ctx.paths().keystore,
      privateKeyConfigured: true,
    },
    out,
    (v) => `${JSON.stringify(v as Record<string, unknown>, null, 2)}\n`,
  );
  return 0;
}

export async function configRemoveCmd(ctx: Context, out: OutputOptions): Promise<number> {
  await clearKey(ctx.flags.env);
  const { rmSync } = await import("node:fs");
  try {
    rmSync(ctx.paths().config, { force: true });
  } catch {
    /* already gone */
  }
  emitSuccess({ removed: true, configFile: ctx.paths().config }, out);
  return 0;
}

export interface ApproveArgs {
  agentAddress: string;
  agentName?: string | undefined;
  masterKey: string;
  dryRun: boolean;
}

/**
 * Register an agent address with the account.
 *
 * This is a USER-SIGNED action, so it must be signed by the account's MASTER
 * key - not the stored agent key. The master key is supplied per invocation and
 * is never written to disk or to the keystore.
 */
export async function agentApproveCmd(ctx: Context, args: ApproveArgs, out: OutputOptions): Promise<number> {
  const cfg = await ctx.config();
  const agentAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(args.agentAddress).toLowerCase();
  const nonce = Date.now();
  const action = approveAgentAction({
    agentAddress,
    agentName: args.agentName,
    testnet: cfg.network === "testnet",
    nonce,
  });

  const master = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "master key must be 0x + 64 hex chars")
    .transform((s) => s.toLowerCase() as `0x${string}`)
    .parse(args.masterKey);
  const result = await signAndSendUserSigned({
    action,
    types: ApproveAgentTypes,
    privateKey: master,
    signOnly: args.dryRun,
  });

  emitSuccess(
    {
      dryRun: args.dryRun,
      network: cfg.network,
      accountAddress: cfg.accountAddress,
      agentAddress,
      signatureChainId: action.signatureChainId,
      hyperliquidChain: action.hyperliquidChain,
      posted: result.signed,
      envelope: args.dryRun ? redactSignature(result.envelope) : undefined,
    },
    out,
  );
  return 0;
}

export async function agentStatusCmd(ctx: Context, out: OutputOptions): Promise<number> {
  const cfg = await ctx.config();
  emitSuccess(
    {
      network: cfg.network,
      accountAddress: cfg.accountAddress,
      agentAddress: cfg.agentAddress,
      storageBackend: cfg.storageBackend,
      note: "the agent key can sign L1 trading actions; only the master key can approve an agent or move funds",
    },
    out,
  );
  return 0;
}

function redactSignature(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null) return envelope;
  const clone = JSON.parse(JSON.stringify(envelope)) as { signature?: { r: string; s: string; v: number } };
  if (clone.signature !== undefined) {
    clone.signature = { r: `${String(clone.signature.r).slice(0, 10)}...`, s: `${String(clone.signature.s).slice(0, 10)}...`, v: clone.signature.v };
  }
  return clone;
}

export { readFileSync };
