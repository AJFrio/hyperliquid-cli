import { z } from "zod";
import { signL1Action, signUserSignedAction } from "@nktkas/hyperliquid/signing";
import { privateKeyToAccount } from "viem/accounts";
import { ApproveAgentTypes } from "@nktkas/hyperliquid/api/exchange";
import { exchangeUrl, postJson } from "./transport.js";
import { ExchangeRejectedError, UsageError } from "../errors.js";

export const envelopeSchema = z.object({ status: z.string() });
export const orderStatusResponseSchema = z.object({
  status: z.string(),
  response: z.object({
    type: z.string(),
    data: z.object({ statuses: z.array(z.unknown()) }).optional(),
  }).optional(),
});

export interface SignAndSendArgs {
  action: Record<string, unknown>;
  privateKey: `0x${string}`;
  testnet: boolean;
  nonce: number;
  vaultAddress?: `0x${string}` | undefined;
  expiresAfter?: number | undefined;
  fetchImpl?: typeof fetch;
  signOnly?: boolean;
}

/**
 * Sign an L1 action and (unless signOnly) POST it to /exchange.
 *
 * The action MUST already have been through buildAction.* so that msgpack key
 * order is canonical and optional false booleans are absent.
 */
export async function signAndSendL1(args: SignAndSendArgs): Promise<{ envelope: unknown; signed: boolean }> {
  const wallet = privateKeyToAccount(args.privateKey);
  const signature = await signL1Action({
    wallet,
    action: args.action,
    nonce: args.nonce,
    isTestnet: args.testnet,
    ...(args.vaultAddress === undefined ? {} : { vaultAddress: args.vaultAddress }),
    ...(args.expiresAfter === undefined ? {} : { expiresAfter: args.expiresAfter }),
  });

  const envelope = {
    action: args.action,
    nonce: args.nonce,
    signature,
    ...(args.vaultAddress === undefined ? {} : { vaultAddress: args.vaultAddress }),
    ...(args.expiresAfter === undefined ? {} : { expiresAfter: args.expiresAfter }),
  };

  if (args.signOnly === true) return { envelope, signed: false };

  const raw = await postJson(exchangeUrl(args.testnet), envelope, {
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
  });
  assertAccepted(raw);
  return { envelope, signed: true };
}

/** Sign a user-signed action such as approveAgent. Requires the MASTER key. */
export async function signAndSendUserSigned(args: {
  action: { signatureChainId: `0x${string}`; [k: string]: unknown };
  types: Record<string, readonly { name: string; type: string }[]>;
  privateKey: `0x${string}`;
  fetchImpl?: typeof fetch;
  signOnly?: boolean;
}): Promise<{ envelope: unknown; signed: boolean }> {
  const wallet = privateKeyToAccount(args.privateKey);
  const signature = await signUserSignedAction({ wallet, action: args.action, types: args.types });
  const envelope = { action: args.action, signature, nonce: args.action["nonce"] };
  if (args.signOnly === true) return { envelope, signed: false };
  const raw = await postJson(exchangeUrl(args.action["hyperliquidChain"] === "Testnet"), envelope, {
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
  });
  assertAccepted(raw);
  return { envelope, signed: true };
}

/**
 * The exchange answers HTTP 200 even when it refuses an action, so a transport
 * success is not a trading success. The verdict lives in the body's `status`.
 */
function assertAccepted(raw: unknown): void {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExchangeRejectedError(`unrecognised exchange response: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  if (parsed.data.status === "err") {
    const message =
      typeof raw === "object" && raw !== null && "response" in raw
        ? String((raw as { response: unknown }).response)
        : "no reason supplied";
    throw new ExchangeRejectedError(`exchange rejected the action: ${message}`, { response: raw });
  }
}

export const approveAgentAction = (opts: {
  agentAddress: string;
  agentName?: string | undefined;
  testnet: boolean;
  nonce: number;
}) => ({
  type: "approveAgent" as const,
  signatureChainId: "0x66eee" as const,
  hyperliquidChain: opts.testnet ? "Testnet" : "Mainnet",
  agentAddress: opts.agentAddress.toLowerCase() as `0x${string}`,
  agentName: opts.agentName ?? "",
  nonce: opts.nonce,
});

export { ApproveAgentTypes, UsageError };
