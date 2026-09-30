import { describe, expect, it } from "vitest";
import { Context } from "../../src/cli/context.js";
import type { OutputOptions } from "../../src/cli/output.js";
import { dispatch } from "../../src/commands/dispatch.js";
import { buildCancel } from "../../src/signing/buildAction.js";

const PRIVATE_KEY = `0x${"3".repeat(64)}`;

function context(full = false): Context {
  return new Context({
    testnet: true,
    dryRun: true,
    table: false,
    quiet: false,
    full,
    env: { HLCLI_AGENT_PRIVATE_KEY: PRIVATE_KEY },
  });
}

function output(full = false): { opts: OutputOptions; chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    opts: { table: false, quiet: false, full, write: (text) => chunks.push(text) },
  };
}

function largeCancelAction() {
  return buildCancel(
    Array.from({ length: 25 }, (_, index) => ({ asset: index, oid: index + 1 })),
    { fast: false },
  ) as Record<string, unknown>;
}

describe("dispatch output for large batches", () => {
  it("shows a bounded dry-run preview and never posts", async () => {
    const cap = output();
    expect(await dispatch(context(), largeCancelAction(), "cancel 25 open orders", cap.opts)).toBe(
      0,
    );
    const payload = JSON.parse(cap.chunks.join("")) as {
      dryRun: boolean;
      posted: boolean;
      envelope?: unknown;
      envelopeSummary: { itemCount: number; items: unknown[]; omitted: number };
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.posted).toBe(false);
    expect(payload.envelope).toBeUndefined();
    expect(payload.envelopeSummary).toMatchObject({ itemCount: 25, omitted: 5 });
    expect(payload.envelopeSummary.items).toHaveLength(20);
  });

  it("includes the complete signed envelope when --full is set", async () => {
    const cap = output(true);
    expect(
      await dispatch(context(true), largeCancelAction(), "cancel 25 open orders", cap.opts),
    ).toBe(0);
    const payload = JSON.parse(cap.chunks.join("")) as {
      posted: boolean;
      envelope: { action: { cancels: unknown[] } };
      envelopeSummary?: unknown;
    };
    expect(payload.posted).toBe(false);
    expect(payload.envelope.action.cancels).toHaveLength(25);
    expect(payload.envelopeSummary).toBeUndefined();
  });
});
