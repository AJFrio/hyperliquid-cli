import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import * as configCmd from "../../commands/config.js";
import { UsageError } from "../../errors.js";
import { ENV_AGENT_KEY } from "../../storage/keystore.js";
import { contextFrom, globalsFor, outOf } from "../globals.js";
import type { Writer } from "../output.js";

/**
 * Read a secret from a file or an env var, never from argv.
 *
 * argv values are visible in shell history and in `ps` output, so this CLI
 * refuses to accept a bare key flag. Key files, environment variables, and
 * init's hidden terminal prompt are the supported channels.
 */
function secretFromSource(
  file: string | undefined,
  envVar: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      throw new UsageError("USAGE", `cannot read secret file: ${file}`);
    }
  }
  const fromEnv = env[envVar];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv.trim();
  return undefined;
}

function readSecret(
  file: string | undefined,
  envVar: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = secretFromSource(file, envVar, env);
  if (secret !== undefined) return secret;
  throw new UsageError("USAGE", `provide --key-file <path> or set ${envVar}`);
}

async function promptLine(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      "USAGE",
      "interactive setup requires a terminal; provide the missing options",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

/** Read a key without echoing its characters to the terminal. */
async function promptPrivateKey(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new UsageError(
      "USAGE",
      `provide --key-file <path>, set ${ENV_AGENT_KEY}, or run init in a terminal for a hidden prompt`,
    );
  }

  process.stderr.write("API wallet private key (input hidden): ");
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    let value = "";
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      process.stderr.write("\n");
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString()) {
        if (char === "\u0003" || char === "\u0004") {
          finish(new UsageError("USAGE", "interactive setup canceled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " " && char <= "~") {
          value += char;
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export function registerSetup(program: Command, write?: Writer): void {
  program
    .command("init")
    .description("one-time setup: store the agent signing key and the account address it trades")
    .option(
      "--account <address>",
      "account (master/sub-account) address that owns the positions; prompted if omitted",
    )
    .option("--agent-address <address>", "API wallet address; checked against the private key")
    .option("--key-file <path>", `file containing the agent private key (or set ${ENV_AGENT_KEY})`)
    .option("--network <n>", "mainnet or testnet", "mainnet")
    .option("--agent-name <name>", "label for the agent registration")
    .action(async (opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as {
        account?: string;
        agentAddress?: string;
        keyFile?: string;
        network: string;
        agentName?: string;
      };
      const account = o.account ?? (await promptLine("Account address (master or sub-account): "));
      let agentAddress = o.agentAddress;
      if (agentAddress === undefined && process.stdin.isTTY) {
        agentAddress =
          (await promptLine("API wallet address (optional; press Enter to derive it): ")) ||
          undefined;
      }
      const key = secretFromSource(o.keyFile, ENV_AGENT_KEY) ?? (await promptPrivateKey());
      process.exitCode = await configCmd.initCmd(
        contextFrom(p),
        {
          accountAddress: account,
          agentAddress,
          privateKey: key,
          network: o.network === "testnet" ? "testnet" : "mainnet",
          agentName: o.agentName,
        },
        outOf(p, write),
      );
    });

  const cfg = program.command("config").description("inspect or remove stored configuration");
  cfg.command("show").action(async (_o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await configCmd.configShowCmd(contextFrom(p), outOf(p, write));
  });
  cfg
    .command("remove")
    .description("delete the stored key and config for this config dir")
    .action(async (_o, cmd: Command) => {
      const p = globalsFor(cmd);
      process.exitCode = await configCmd.configRemoveCmd(contextFrom(p), outOf(p, write));
    });

  const agent = program.command("agent").description("agent key registration");
  agent
    .command("approve")
    .description(
      "register an agent address with the account; needs the MASTER key, supplied per-invocation and never stored",
    )
    .option("--agent-address <address>", "agent address to register (defaults to the stored one)")
    .option(
      "--master-key-file <path>",
      "file containing the MASTER private key (or set HLCLI_MASTER_PRIVATE_KEY)",
    )
    .option("--agent-name <name>", "label for the registration")
    .action(async (opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as { agentAddress?: string; masterKeyFile?: string; agentName?: string };
      const ctx = contextFrom(p);
      const cfg = await ctx.config();
      process.exitCode = await configCmd.agentApproveCmd(
        ctx,
        {
          agentAddress: o.agentAddress ?? cfg.agentAddress,
          agentName: o.agentName,
          masterKey: readSecret(o.masterKeyFile, "HLCLI_MASTER_PRIVATE_KEY"),
          dryRun: p.dryRun,
        },
        outOf(p, write),
      );
    });
  agent.command("status").action(async (_o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await configCmd.agentStatusCmd(contextFrom(p), outOf(p, write));
  });
}
