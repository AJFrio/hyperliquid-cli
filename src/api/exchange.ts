import { ApproveAgentTypes } from "@nktkas/hyperliquid/api/exchange";
import { signL1Action, signUserSignedAction } from "@nktkas/hyperliquid/signing";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { ExchangeRejectedError, UsageError } from "../errors.js";
import { exchangeUrl, postJson } from "./transport.js";

export const envelopeSchema = z.object({ status: z.string() });
export const orderStatusResponseSchema = z.object({
  status: z.string(),
  response: z
    .object({
      type: z.string(),
      data: z.object({ statuses: z.array(z.unknown()) }).optional(),
    })
    .optional(),
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
export async function signAndSendL1(
  args: SignAndSendArgs,
): Promise<{ envelope: unknown; signed: boolean; exchangeResponse?: unknown }> {
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
  return { envelope, signed: true, exchangeResponse: raw };
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
  const envelope = { action: args.action, signature, nonce: args.action.nonce };
  if (args.signOnly === true) return { envelope, signed: false };
  const raw = await postJson(exchangeUrl(args.action.hyperliquidChain === "Testnet"), envelope, {
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
    throw new ExchangeRejectedError(
      `unrecognised exchange response: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  if (parsed.data.status === "err") {
    const message =
      typeof raw === "object" && raw !== null && "response" in raw
        ? String((raw as { response: unknown }).response).slice(0, 500)
        : "no reason supplied";
    throw new ExchangeRejectedError(`exchange rejected the action: ${message}`, {
      response: message,
    });
  }

  const response =
    typeof raw === "object" && raw !== null && "response" in raw
      ? (raw as { response?: unknown }).response
      : undefined;
  const data =
    typeof response === "object" && response !== null && "data" in response
      ? (response as { data?: unknown }).data
      : undefined;
  const statuses =
    typeof data === "object" && data !== null && "statuses" in data
      ? (data as { statuses?: unknown }).statuses
      : undefined;
  if (Array.isArray(statuses)) {
    const messages = statuses.flatMap((status) => {
      if (typeof status !== "object" || status === null || !("error" in status)) return [];
      const message = (status as { error: unknown }).error;
      return typeof message === "string" ? [message] : [JSON.stringify(message)];
    });
    if (messages.length > 0) {
      const sample = messages.slice(0, 5);
      throw new ExchangeRejectedError(
        `exchange rejected ${messages.length} item(s): ${sample.join("; ")}${messages.length > sample.length ? "; additional errors omitted" : ""}`,
        {
          rejectionCount: messages.length,
          errors: sample,
        },
      );
    }
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
