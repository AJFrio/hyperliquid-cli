import { describe, expect, it } from "vitest";
import { pageRows } from "../../src/cli/output.js";

describe("pageRows", () => {
  it("returns a bounded page with accurate metadata", () => {
    expect(pageRows([1, 2, 3, 4, 5], { page: 2, limit: 2 })).toEqual({
      rows: [3, 4],
      page: {
        number: 2,
        limit: 2,
        returned: 2,
        total: 5,
        hasMore: true,
        sourceLimited: false,
      },
    });
  });

  it("pages newest-first while allowing callers to restore chronological order", () => {
    const result = pageRows([1, 2, 3, 4, 5], { page: 1, limit: 2 }, { newestFirst: true });
    expect(result.rows).toEqual([5, 4]);
    expect(result.page.hasMore).toBe(true);
  });

  it("marks capped source totals as unknown", () => {
    const result = pageRows([1, 2, 3], { limit: 2 }, { sourceLimited: true, total: null });
    expect(result.page).toMatchObject({ total: null, sourceLimited: true, hasMore: true });
  });

  it("rejects invalid page, limit, and all combinations", () => {
    expect(() => pageRows([1], { page: 0 })).toThrow("--page must be a positive integer");
    expect(() => pageRows([1], { limit: 101 })).toThrow("--limit must be an integer");
    expect(() => pageRows([1], { all: true, page: 1 })).toThrow("--all cannot be combined");
  });
});
