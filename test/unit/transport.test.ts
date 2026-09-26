import { describe, expect, it, vi } from "vitest";
import { apiUrlFor, MAINNET_API_URL, postJson, TESTNET_API_URL } from "../../src/api/transport.js";
import { ApiError, NetworkError } from "../../src/errors.js";

function jsonResponse(body: unknown, init: { status?: number; contentType?: string } = {}): Response {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? "application/json";
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe("apiUrlFor", () => {
  it("selects the correct network base URL", () => {
    expect(apiUrlFor(false)).toBe(MAINNET_API_URL);
    expect(apiUrlFor(true)).toBe(TESTNET_API_URL);
  });
});

describe("postJson", () => {
  it("returns the parsed body on a 200 JSON response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ type: "ok" }));
    const result = await postJson<{ type: string }>(
      "https://example.test/info",
      { type: "meta" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({ type: "ok" });
  });

  it("sends the body as JSON with the right content type", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await postJson("https://example.test/info", { type: "meta" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ type: "meta" });
    expect(init.method).toBe("POST");
  });

  // This is the regression that matters: the live API answers errors as text/plain,
  // so a naive response.json() throws SyntaxError and hides the real message.
  it("surfaces a text/plain 422 error body instead of throwing a parse error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse("Failed to deserialize the JSON body into the target type", {
        status: 422,
        contentType: "text/plain",
      }),
    );
    await expect(
      postJson("https://api.hyperliquid.xyz/info", { type: "notARealType" }, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("includes status and body text in the ApiError details", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse("Failed to deserialize the JSON body into the target type", {
        status: 422,
        contentType: "text/plain",
      }),
    );
    const err = await postJson("https://x.test/info", {}, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const cliErr = err as ApiError;
    expect(cliErr.exitCode).toBe(1);
    expect(cliErr.details?.["status"]).toBe(422);
    expect(String(cliErr.details?.["body"])).toContain("deserialize");
    expect(cliErr.message).toContain("422");
  });

  it("rejects a 2xx that is not JSON rather than returning a string", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("<html>proxy error</html>", { contentType: "text/html" }));
    const err = await postJson("https://x.test/info", {}, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("non-JSON");
  });

  it("wraps transport failures as NetworkError with exit code 1", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.hyperliquid.xyz");
    });
    const err = await postJson("https://x.test/info", {}, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).exitCode).toBe(1);
    expect((err as NetworkError).message).toContain("ENOTFOUND");
  });

  it("truncates an enormous error body instead of dumping it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("x".repeat(5000), { status: 500, contentType: "text/plain" }));
    const err = await postJson("https://x.test/info", {}, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e: unknown) => e);
    expect((err as ApiError).message.length).toBeLessThan(500);
  });
});
