import { HlCliError, toCliError } from "../errors.js";

export type Writer = (text: string) => void;

export interface OutputOptions {
  table: boolean;
  quiet: boolean;
  /**
   * Where payload text goes. Injectable so the whole output path is testable;
   * the real CLI passes a writer bound to process.stdout.
   */
  write: Writer;
}

export const defaultOutput: OutputOptions = {
  table: false,
  quiet: false,
  write: (t) => process.stdout.write(t),
};

/**
 * Agent-first output contract:
 *   - success -> pretty JSON on stdout (or a table when --table is passed)
 *   - failure -> a single JSON object on stderr, never mixed into stdout
 * Exit codes come from the error itself (2 usage/validation, 1 runtime).
 */
export function emitSuccess(value: unknown, opts: OutputOptions, toTable?: (v: unknown) => string): void {
  const text = opts.table && toTable !== undefined ? toTable(value) : `${JSON.stringify(value, null, 2)}\n`;
  if (!opts.quiet) opts.write(text);
}

export function emitError(err: unknown, write: Writer = (t) => process.stderr.write(t)): { text: string; exitCode: number } {
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
