import { Command } from "commander";
import { registerAccount } from "./cli/groups/account.js";
import { registerMarket } from "./cli/groups/market.js";
import { registerSetup } from "./cli/groups/setup.js";
import { registerTrading } from "./cli/groups/trading.js";
import type { OutputOptions, Writer } from "./cli/output.js";
import { toCliError } from "./errors.js";

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
  program.exitOverride();
  program.configureOutput({
    writeOut: (t) => io.stdout(t),
    writeErr: (t) => io.stderr(t),
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    const code = process.exitCode;
    return typeof code === "number" ? code : 0;
  } catch (err) {
    const cliErr = toCliError(err);
    const commanderCode = (err as { code?: string }).code;
    if (
      commanderCode === "commander.helpDisplayed" ||
      commanderCode === "commander.help" ||
      commanderCode === "commander.version"
    ) {
      return 0;
    }
    io.stderr(`${JSON.stringify(cliErr.toJSON(), null, 2)}\n`);
    return commanderCode === "commander.unknownCommand" ||
      commanderCode?.startsWith("commander.") === true
      ? 2
      : cliErr.exitCode;
  }
}

export { emitError, emitSuccess } from "./cli/output.js";
export type { OutputOptions };
