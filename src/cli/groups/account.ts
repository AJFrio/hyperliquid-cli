import type { Command } from "commander";
import * as account from "../../commands/account.js";
import { contextFrom, globalsFor, outOf } from "../globals.js";
import type { Writer } from "../output.js";

export function registerAccount(program: Command, write?: Writer): void {
  const acct = program.command("account").description("read-only account state for the configured account address");

  acct.command("state").action(async (_o, cmd: Command) => {
    process.exitCode = await account.stateCmd(contextFrom(globalsFor(cmd)), outOf(globalsFor(cmd)));
  });
  acct.command("spot").action(async (_o, cmd: Command) => {
    process.exitCode = await account.spotCmd(contextFrom(globalsFor(cmd)), outOf(globalsFor(cmd)));
  });
  acct.command("orders").action(async (_o, cmd: Command) => {
    process.exitCode = await account.ordersCmd(contextFrom(globalsFor(cmd)), outOf(globalsFor(cmd)));
  });
  acct
    .command("order-status")
    .argument("<oid>", "order id, or a 0x-prefixed cloid")
    .action(async (oid, _o, cmd: Command) => {
      process.exitCode = await account.orderStatusCmd(contextFrom(globalsFor(cmd)), oid, outOf(globalsFor(cmd)));
    });
  acct.command("fills").action(async (_o, cmd: Command) => {
    process.exitCode = await account.fillsCmd(contextFrom(globalsFor(cmd)), outOf(globalsFor(cmd)));
  });
  acct.command("funding").option("--since-hours <h>", "look back N hours", "24").action(async (opts, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await account.fundingCmd(contextFrom(p), { sinceHours: Number((opts as { sinceHours: string }).sinceHours) }, outOf(p, write));
  });
  acct.command("ledger").option("--since-hours <h>", "look back N hours", "24").action(async (opts, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await account.ledgerCmd(contextFrom(p), { sinceHours: Number((opts as { sinceHours: string }).sinceHours) }, outOf(p, write));
  });
  acct.command("rate-limit").action(async (_o, cmd: Command) => {
    process.exitCode = await account.rateLimitCmd(contextFrom(globalsFor(cmd)), outOf(globalsFor(cmd)));
  });
  acct.command("role").action(async (_o, cmd: Command) => {
    process.exitCode = await account.roleCmd(contextFrom(globalsFor(cmd)), outOf(globalsFor(cmd)));
  });
}
