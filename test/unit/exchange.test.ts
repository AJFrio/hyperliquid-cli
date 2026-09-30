import { describe, expect, it, vi } from "vitest";
import { signAndSendL1 } from "../../src/api/exchange.js";

const PRIVATE_KEY = `0x${"3".repeat(64)}` as `0x${string}`;
const ORDER_ACTION = {
  type: "order",
  orders: [
    { a: 10000, b: false, p: "0.1358", s: "74.94751", r: false, t: { limit: { tif: "Ioc" } } },
  ],
  grouping: "na",
};

function exchangeReply(body: unknown): typeof fetch {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  return fetchImpl as unknown as typeof fetch;
}

describe("signAndSendL1 exchange responses", () => {
  it("rejects per-order errors inside a top-level ok response", async () => {
    const fetchImpl = exchangeReply({
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ error: "Order size has too many decimals." }] },
      },
    });

    await expect(
      signAndSendL1({
        action: ORDER_ACTION,
        privateKey: PRIVATE_KEY,
        testnet: false,
        nonce: Date.now(),
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "EXCHANGE_REJECTED",
      details: {
        rejectionCount: 1,
        errors: ["Order size has too many decimals."],
      },
    });
  });

  it("returns the exchange's action result after an accepted order", async () => {
    const reply = {
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ filled: { totalSz: "74", avgPx: "0.13591", oid: 7 } }] },
      },
    };
    const result = await signAndSendL1({
      action: ORDER_ACTION,
      privateKey: PRIVATE_KEY,
      testnet: false,
      nonce: Date.now(),
      fetchImpl: exchangeReply(reply),
    });

    expect(result.signed).toBe(true);
    expect(result.exchangeResponse).toEqual(reply);
  });
});
