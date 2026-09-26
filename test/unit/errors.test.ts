import { describe, expect, it } from "vitest";
import {
  ApiError,
  ExchangeRejectedError,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  HlCliError,
  NetworkError,
  NotConfiguredError,
  UsageError,
  toCliError,
} from "../../src/errors.js";

describe("error exit-code contract", () => {
  it("uses 0 for success", () => {
    expect(EXIT_OK).toBe(0);
  });

  it("maps usage/validation problems to exit 2", () => {
    expect(new UsageError("USAGE", "bad flag").exitCode).toBe(2);
    expect(new UsageError("UNKNOWN_ASSET", "nope").exitCode).toBe(2);
    expect(new UsageError("INVALID_INPUT", "bad size").exitCode).toBe(2);
    expect(new NotConfiguredError("run init first").exitCode).toBe(2);
    expect(EXIT_USAGE).toBe(2);
  });

  it("maps runtime/network/exchange problems to exit 1", () => {
    expect(new NetworkError("timeout").exitCode).toBe(1);
    expect(new ApiError("422").exitCode).toBe(1);
    expect(new ExchangeRejectedError("min notional").exitCode).toBe(1);
    expect(EXIT_RUNTIME).toBe(1);
  });
});

describe("error serialisation", () => {
  it("emits a stable machine-readable shape on the wire", () => {
    const err = new UsageError("UNKNOWN_ASSET", "no such coin", { coin: "NOPE" });
    expect(err.toJSON()).toEqual({
      error: { code: "UNKNOWN_ASSET", message: "no such coin", details: { coin: "NOPE" } },
    });
  });

  it("omits details entirely when there are none", () => {
    expect(new UsageError("USAGE", "x").toJSON()).toEqual({
      error: { code: "USAGE", message: "x" },
    });
  });

  it("keeps the class name for debugging", () => {
    expect(new NetworkError("boom").name).toBe("NetworkError");
  });
});

describe("toCliError", () => {
  it("passes an HlCliError through untouched", () => {
    const original = new UsageError("USAGE", "keep");
    expect(toCliError(original)).toBe(original);
  });

  it("wraps a plain Error as INTERNAL at exit 1", () => {
    const wrapped = toCliError(new Error("kaboom"));
    expect(wrapped).toBeInstanceOf(HlCliError);
    expect(wrapped.code).toBe("INTERNAL");
    expect(wrapped.exitCode).toBe(1);
    expect(wrapped.message).toBe("kaboom");
  });

  it("wraps a thrown non-Error value instead of leaking String() undefined", () => {
    const wrapped = toCliError("just a string");
    expect(wrapped.code).toBe("INTERNAL");
    expect(wrapped.message).toBe("just a string");
    expect(wrapped.exitCode).toBe(1);
  });

  it("wraps null and undefined without crashing", () => {
    expect(toCliError(null).message).toBe("null");
    expect(toCliError(undefined).message).toBe("undefined");
  });
});
