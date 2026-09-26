import { signAndSendL1 } from "../api/exchange.js";
import { emitSuccess, type OutputOptions } from "../cli/output.js";
import type { Context } from "../cli/context.js";

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
  const { envelope, signed } = await signAndSendL1({
    action,
    privateKey,
    testnet: ctx.flags.testnet,
    nonce: nextNonce(),
    signOnly: dryRun,
  });
  emitSuccess(
    {
      dryRun,
      posted: signed,
      action: label,
      ...(dryRun ? { envelope: redact(envelope) } : { response: envelope }),
    },
    out,
  );
  return 0;
}

/** Truncate signature components so a dry-run transcript is not a replayable artifact. */
export function redact(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null) return envelope;
  const clone = JSON.parse(JSON.stringify(envelope)) as { signature?: { r: string; s: string; v: number } };
  if (clone.signature !== undefined) {
    clone.signature = {
      r: `${String(clone.signature.r).slice(0, 12)}...`,
      s: `${String(clone.signature.s).slice(0, 12)}...`,
      v: clone.signature.v,
    };
  }
  return clone;
}
