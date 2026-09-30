import { type HlCliError, toCliError, UsageError } from "../errors.js";

export type Writer = (text: string) => void;

export interface OutputOptions {
  table: boolean;
  quiet: boolean;
  full: boolean;
  /**
   * Where payload text goes. Injectable so the whole output path is testable;
   * the real CLI passes a writer bound to process.stdout.
   */
  write: Writer;
}

export interface PageRequest {
  page?: number | undefined;
  limit?: number | undefined;
  all?: boolean | undefined;
}

export interface PageInfo {
  number: number;
  limit: number | null;
  returned: number;
  total: number | null;
  hasMore: boolean;
  sourceLimited: boolean;
}

export interface PageResult<T> {
  rows: T[];
  page: PageInfo;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const defaultOutput: OutputOptions = {
  table: false,
  quiet: false,
  full: false,
  write: (t) => process.stdout.write(t),
};

/** Validate and apply a page to an already ordered response. */
export function pageRows<T>(
  sourceRows: T[],
  request: PageRequest = {},
  options: { total?: number | null; sourceLimited?: boolean; newestFirst?: boolean } = {},
): PageResult<T> {
  const pageNumber = request.page ?? 1;
  const pageSize = request.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new UsageError("USAGE", "--page must be a positive integer", { page: request.page });
  }
  if (request.all === true && (request.page !== undefined || request.limit !== undefined)) {
    throw new UsageError("USAGE", "--all cannot be combined with --page or --limit");
  }
  if (
    request.all !== true &&
    (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
  ) {
    throw new UsageError("USAGE", `--limit must be an integer from 1 to ${MAX_PAGE_SIZE}`, {
      limit: request.limit,
    });
  }

  const ordered = options.newestFirst === true ? [...sourceRows].reverse() : sourceRows;
  const start = request.all === true ? 0 : (pageNumber - 1) * pageSize;
  const limit = request.all === true ? ordered.length : pageSize;
  const rows = ordered.slice(start, start + limit);
  const total =
    options.total === undefined
      ? options.sourceLimited
        ? null
        : sourceRows.length
      : options.total;
  return {
    rows,
    page: {
      number: request.all === true ? 1 : pageNumber,
      limit: request.all === true ? null : pageSize,
      returned: rows.length,
      total,
      hasMore: start + rows.length < ordered.length,
      sourceLimited: options.sourceLimited === true,
    },
  };
}

/**
 * Agent-first output contract:
 *   - success -> pretty JSON on stdout (or a table when --table is passed)
 *   - failure -> a single JSON object on stderr, never mixed into stdout
 * Exit codes come from the error itself (2 usage/validation, 1 runtime).
 */
export function emitSuccess(
  value: unknown,
  opts: OutputOptions,
  toTable?: (v: unknown) => string,
): void {
  const text =
    opts.table && toTable !== undefined ? toTable(value) : `${JSON.stringify(value, null, 2)}\n`;
  if (!opts.quiet) opts.write(text);
}

export function emitError(
  err: unknown,
  write: Writer = (t) => process.stderr.write(t),
): { text: string; exitCode: number } {
  const cliError: HlCliError = toCliError(err);
  const text = `${JSON.stringify(cliError.toJSON(), null, 2)}\n`;
  write(text);
  return { text, exitCode: cliError.exitCode };
}

type Row = Record<string, unknown>;

export function renderTable(value: unknown, columns?: string[]): string {
  const rows = Array.isArray(value) ? (value as Row[]) : value === undefined ? [] : [value as Row];
  if (rows.length === 0) return "(no rows)\n";
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const header = cols.join("\t");
  const body = rows.map((r) => cols.map((c) => formatCell(r[c])).join("\t")).join("\n");
  return `${header}\n${body}\n`;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
