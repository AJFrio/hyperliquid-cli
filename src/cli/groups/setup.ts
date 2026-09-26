import { readFileSync } from "node:fs";
import type { Command } from "commander";
import * as configCmd from "../../commands/config.js";
import { contextFrom, globalsFor, outOf } from "../globals.js";
import type { Writer } from "../output.js";
import { UsageError } from "../../errors.js";
import { ENV_AGENT_KEY } from "../../storage/keystore.js";

/**
 * Read a secret from a file or an env var, never from argv.
 *
 * argv values are visible in shell history and in `ps` output, so this CLI
 * refuses to accept a bare key flag. `--*-key-file` and the env var are the
 * only supported channels.
 */
function readSecret(file: string | undefined, envVar: string, env: NodeJS.ProcessEnv = process.env): string {
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      throw new UsageError("USAGE", `cannot read secret file: ${file}`);
    }
  }
  const fromEnv = env[envVar];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv.trim();
  throw new UsageError("USAGE", `provide --key-file <path> or set ${envVar}`);
}

export function registerSetup(program: Command, write?: Writer): void {
  program
    .command("init")
    .description("one-time setup: store the agent signing key and the account address it trades")
    .requiredOption("--account <address>", "account (master/sub-account) address that owns the positions")
    .option("--key-file <path>", `file containing the agent private key (or set ${ENV_AGENT_KEY})`)
    .option("--network <n>", "mainnet or testnet", "mainnet")
    .option("--agent-name <name>", "label for the agent registration")
    .action(async (opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as { account: string; keyFile?: string; network: string; agentName?: string };
      process.exitCode = await configCmd.initCmd(
        contextFrom(p),
        {
          accountAddress: o.account,
          privateKey: readSecret(o.keyFile, ENV_AGENT_KEY),
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
    .description("register an agent address with the account; needs the MASTER key, supplied per-invocation and never stored")
    .option("--agent-address <address>", "agent address to register (defaults to the stored one)")
    .option("--master-key-file <path>", "file containing the MASTER private key (or set HLCLI_MASTER_PRIVATE_KEY)")
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
