import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Signing/transport tests must never reach the network by accident.
    testTimeout: 20_000,
  },
});
