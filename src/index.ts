import { Command } from "commander";
import { registerAccount } from "./cli/groups/account.js";
import { registerMarket } from "./cli/groups/market.js";
import { registerSetup } from "./cli/groups/setup.js";
import { registerTrading } from "./cli/groups/trading.js";
import type { OutputOptions, Writer } from "./cli/output.js";
import { toCliError, UsageError } from "./errors.js";

export const VERSION = "0.1.0";

export function buildProgram(write?: Writer): Command {
  const program = new Command();
  program
    .name("hyperliquid")
    .description(
      "Agent-first CLI for Hyperliquid. JSON on stdout, structured JSON errors on stderr.\n" +
        "Exit codes: 0 ok, 2 usage/validation, 1 runtime/network.\n\n" +
        "Fund movements (withdraw, transfer, delegate) are intentionally NOT implemented.",
    )
    .version(VERSION, "-V, --version", "print the version")
    .option("--testnet", "use the testnet deployment (no real funds)", false)
    .option("--dry-run", "sign and print the envelope without posting to /exchange", false)
    .option("--table", "human-readable table instead of JSON", false)
    .option("-q, --quiet", "suppress stdout", false)
    .option("--config-dir <path>", "override the config directory (also HLCLI_CONFIG_DIR)")
    .showHelpAfterError();

  registerMarket(program, write);
  registerAccount(program, write);
  registerTrading(program, write);
  registerSetup(program, write);
  return program;
}

export interface RunIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: RunIo = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
};

/**
 * Run the CLI and return a process exit code. Never throws: every failure path
 * is converted into a structured error document.
 */
export async function run(argv: string[], io: RunIo = defaultIo): Promise<number> {
  const program = buildProgram(io.stdout);
  // exitOverride must reach every subcommand. Commander only copies inherited
  // settings at creation time, so setting it on the root afterwards is not
  // enough: a nested unknown command would call process.exit() and kill the
  // process before the error contract could run.
  applyRuntime(program);

  // Commander writes its own plain-text diagnostics (unknown command, unknown
  // option, help) straight to stderr, which would break the documented
  // "errors are always JSON" contract. Buffer it and decide in the catch block:
  // help and version keep their human text, real errors become JSON.
  let pending = "";
  program.configureOutput({
    writeOut: (t) => io.stdout(t),
    writeErr: (t) => {
      pending += t;
    },
  });

  function applyRuntime(cmd: Command): void {
    cmd.exitOverride();
    cmd.configureOutput({
      writeOut: (t) => io.stdout(t),
      writeErr: (t) => {
        pending += t;
      },
    });
    for (const sub of cmd.commands) applyRuntime(sub);
  }

  const flushPending = (): void => {
    if (pending.length > 0) io.stderr(pending);
    pending = "";
  };

  try {
    await program.parseAsync(argv, { from: "user" });
    flushPending();
    const code = process.exitCode;
    return typeof code === "number" ? code : 0;
  } catch (err) {
    const commanderCode = (err as { code?: string }).code ?? "";
    if (
      commanderCode === "commander.helpDisplayed" ||
      commanderCode === "commander.help" ||
      commanderCode === "commander.version"
    ) {
      flushPending();
      return 0;
    }
    pending = "";
    if (commanderCode.startsWith("commander.")) {
      const message = (err as { message?: string }).message;
      const usage = new UsageError(
        "USAGE",
        typeof message === "string" && message.length > 0 ? message : "invalid command",
      );
      io.stderr(`${JSON.stringify(usage.toJSON(), null, 2)}\n`);
      return 2;
    }
    const cliErr = toCliError(err);
    io.stderr(`${JSON.stringify(cliErr.toJSON(), null, 2)}\n`);
    return cliErr.exitCode;
  }
}

export { emitError, emitSuccess } from "./cli/output.js";
export type { OutputOptions };
