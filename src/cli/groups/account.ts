import type { Command } from "commander";
import * as account from "../../commands/account.js";
import { contextFrom, globalsFor, outOf } from "../globals.js";
import type { Writer } from "../output.js";

function addPageOptions(command: Command): Command {
  return command
    .option("--page <n>", "1-based page number", (value: string) => Number(value))
    .option("--limit <n>", "rows per page (1-100)", (value: string) => Number(value))
    .option("--all", "return all rows in the source response", false);
}

function parseTimestamp(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : Date.parse(value);
}

type PageCli = { page?: number; limit?: number; all?: boolean };

export function registerAccount(program: Command, write?: Writer): void {
  const acct = program
    .command("account")
    .description("read-only account state for the configured account address");

  acct
    .command("state")
    .option("--dex <name>", "inspect a specific perp DEX")
    .option("--page <n>", "1-based position page", (value: string) => Number(value))
    .option("--limit <n>", "positions per page (1-100)", (value: string) => Number(value))
    .option("--all", "return all positions", false)
    .action(async (opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as PageCli & { dex?: string };
      process.exitCode = await account.stateCmd(
        contextFrom(p),
        {
          dex: o.dex,
          page: o.page,
          limit: o.limit,
          all: o.all,
        },
        outOf(p, write),
      );
    });

  addPageOptions(acct.command("spot")).action(async (opts: PageCli, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await account.spotCmd(contextFrom(p), opts, outOf(p, write));
  });

  acct
    .command("orders")
    .option("--dex <name>", "inspect orders on a specific perp DEX")
    .option("--page <n>", "1-based order page", (value: string) => Number(value))
    .option("--limit <n>", "orders per page (1-100)", (value: string) => Number(value))
    .option("--all", "return all orders", false)
    .action(async (opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as PageCli & { dex?: string };
      process.exitCode = await account.ordersCmd(
        contextFrom(p),
        {
          dex: o.dex,
          page: o.page,
          limit: o.limit,
          all: o.all,
        },
        outOf(p, write),
      );
    });

  acct
    .command("order-status")
    .argument("<oid>", "order id, or a 0x-prefixed cloid")
    .action(async (oid, _o, cmd: Command) => {
      const p = globalsFor(cmd);
      process.exitCode = await account.orderStatusCmd(contextFrom(p), oid, outOf(p, write));
    });

  addPageOptions(
    acct
      .command("fills")
      .option(
        "--since-hours <h>",
        "query fills within the last N hours; allows older range paging",
        (value: string) => Number(value),
      )
      .option("--end <t>", "range end: ISO 8601 or epoch milliseconds", parseTimestamp),
  ).action(async (opts, cmd: Command) => {
    const p = globalsFor(cmd);
    const o = opts as PageCli & { sinceHours?: number; end?: number };
    process.exitCode = await account.fillsCmd(
      contextFrom(p),
      {
        page: o.page,
        limit: o.limit,
        all: o.all,
        sinceHours: o.sinceHours,
        endTime: o.end,
      },
      outOf(p, write),
    );
  });

  const historyOptions = (command: Command) =>
    addPageOptions(
      command
        .option("--since-hours <h>", "look back N hours", "24")
        .option("--end <t>", "range end: ISO 8601 or epoch milliseconds", parseTimestamp),
    );

  historyOptions(acct.command("funding")).action(async (opts, cmd: Command) => {
    const p = globalsFor(cmd);
    const o = opts as PageCli & { sinceHours: string; end?: number };
    process.exitCode = await account.fundingCmd(
      contextFrom(p),
      {
        sinceHours: Number(o.sinceHours),
        endTime: o.end,
        page: o.page,
        limit: o.limit,
        all: o.all,
      },
      outOf(p, write),
    );
  });

  historyOptions(acct.command("ledger")).action(async (opts, cmd: Command) => {
    const p = globalsFor(cmd);
    const o = opts as PageCli & { sinceHours: string; end?: number };
    process.exitCode = await account.ledgerCmd(
      contextFrom(p),
      {
        sinceHours: Number(o.sinceHours),
        endTime: o.end,
        page: o.page,
        limit: o.limit,
        all: o.all,
      },
      outOf(p, write),
    );
  });

  acct.command("rate-limit").action(async (_o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await account.rateLimitCmd(contextFrom(p), outOf(p, write));
  });
  acct.command("role").action(async (_o, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await account.roleCmd(contextFrom(p), outOf(p, write));
  });
}
