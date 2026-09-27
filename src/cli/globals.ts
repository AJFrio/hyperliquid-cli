import type { Command } from "commander";
import { Context, type GlobalFlags } from "./context.js";
import type { OutputOptions, Writer } from "./output.js";

export interface Parsed {
  testnet: boolean;
  dryRun: boolean;
  table: boolean;
  quiet: boolean;
  configDir?: string | undefined;
}

export function globalsFor(cmd: Command): Parsed {
  const o = cmd.optsWithGlobals() as Parsed;
  return {
    testnet: o.testnet === true,
    dryRun: o.dryRun === true,
    table: o.table === true,
    quiet: o.quiet === true,
    configDir: o.configDir,
  };
}

export function contextFrom(p: Parsed, env: NodeJS.ProcessEnv = process.env): Context {
  // Fold --config-dir into the env the storage layer reads, so the key store,
  // config file and machine key all land in the same isolated directory.
  const effectiveEnv: NodeJS.ProcessEnv =
    p.configDir !== undefined && p.configDir.length > 0
      ? { ...env, HLCLI_CONFIG_DIR: p.configDir }
      : env;
  const flags: GlobalFlags = {
    testnet: p.testnet,
    dryRun: p.dryRun,
    table: p.table,
    quiet: p.quiet,
    configDir: p.configDir,
    env: effectiveEnv,
  };
  return new Context(flags);
}

export function outOf(p: Parsed, write?: Writer): OutputOptions {
  return {
    table: p.table,
    quiet: p.quiet,
    write: write ?? ((t) => process.stdout.write(t)),
  };
}
