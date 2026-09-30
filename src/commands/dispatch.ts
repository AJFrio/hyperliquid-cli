import { signAndSendL1 } from "../api/exchange.js";
import type { Context } from "../cli/context.js";
import { emitSuccess, type OutputOptions } from "../cli/output.js";

let lastNonce = 0;

/** Nonces must strictly increase per signer and sit in (now-2d, now+1d). */
export function nextNonce(): number {
  const now = Date.now();
  lastNonce = now > lastNonce ? now : lastNonce + 1;
  return lastNonce;
}

/** Sign an action and POST it, or short-circuit and show the envelope when --dry-run. */
export async function dispatch(
  ctx: Context,
  action: Record<string, unknown>,
  label: string,
  out: OutputOptions,
): Promise<number> {
  const { privateKey } = await ctx.signingKey();
  const dryRun = ctx.flags.dryRun;
  const { envelope, signed, exchangeResponse } = await signAndSendL1({
    action,
    privateKey,
    testnet: ctx.flags.testnet,
    nonce: nextNonce(),
    signOnly: dryRun,
  });
  const summary = summarizeAction(action);
  const largeBatch = summary.itemCount > 20;
  const response = out.full || !largeBatch ? exchangeResponse : summarizeResponse(exchangeResponse);
  emitSuccess(
    {
      dryRun,
      posted: signed,
      action: label,
      ...(dryRun
        ? out.full || !largeBatch
          ? { envelope: redact(envelope) }
          : { envelopeSummary: { nonce: (envelope as { nonce?: number }).nonce, ...summary } }
        : { response }),
    },
    out,
  );
  return 0;
}

export function summarizeAction(action: Record<string, unknown>): {
  type: unknown;
  itemKey?: string;
  itemCount: number;
  items: unknown[];
  omitted: number;
} {
  const listEntry = Object.entries(action).find(([, value]) => Array.isArray(value));
  if (listEntry === undefined) return { type: action.type, itemCount: 0, items: [], omitted: 0 };
  const [key, value] = listEntry;
  const items = value as unknown[];
  return {
    type: action.type,
    itemKey: key,
    itemCount: items.length,
    items: items.slice(0, 20),
    omitted: Math.max(0, items.length - 20),
  };
}

export function summarizeResponse(response: unknown): unknown {
  if (typeof response !== "object" || response === null) return response;
  const top = response as Record<string, unknown>;
  const envelope =
    typeof top.response === "object" && top.response !== null
      ? (top.response as Record<string, unknown>)
      : undefined;
  const data =
    envelope?.data !== null && typeof envelope?.data === "object"
      ? (envelope.data as Record<string, unknown>)
      : undefined;
  const statuses = Array.isArray(data?.statuses) ? data.statuses : undefined;
  if (statuses === undefined) return response;
  return {
    status: top.status,
    response: {
      type: envelope?.type,
      data: {
        statusCount: statuses.length,
        statuses: statuses.slice(0, 20),
        omitted: Math.max(0, statuses.length - 20),
      },
    },
  };
}

/** Truncate signature components so a dry-run transcript is not a replayable artifact. */
export function redact(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null) return envelope;
  const clone = JSON.parse(JSON.stringify(envelope)) as {
    signature?: { r: string; s: string; v: number };
  };
  if (clone.signature !== undefined) {
    clone.signature = {
      r: `${String(clone.signature.r).slice(0, 12)}...`,
      s: `${String(clone.signature.s).slice(0, 12)}...`,
      v: clone.signature.v,
    };
  }
  return clone;
}
