import type { Command } from "commander";
import * as order from "../../commands/order.js";
import * as margin from "../../commands/margin.js";
import * as twap from "../../commands/twap.js";
import { contextFrom, globalsFor, outOf } from "../globals.js";
import type { Writer } from "../output.js";

export function registerTrading(program: Command, write?: Writer): void {
  const ord = program.command("order").description("signed trading actions; add --dry-run to sign without posting");

  ord
    .command("place")
    .argument("<symbol>")
    .option("--side <side>", "buy or sell", "buy")
    .option("--size <n>", "size in base units, decimal string", "0")
    .option("--price <n>", "limit price, decimal string")
    .option("--spot", "treat <symbol> as a spot pair (asset id 10000+index)", false)
    .option("--reduce-only", "only reduce an existing position", false)
    .option("--tif <tif>", "Gtc | Ioc | Alo | FrontendMarket", "Gtc")
    .option("--trigger-px <n>", "trigger price; makes this a trigger order")
    .option("--trigger-kind <k>", "tp or sl", "tp")
    .option("--market-trigger", "use a market trigger instead of a limit trigger", false)
    .option("--cloid <hex>", "client order id: 0x + 32 hex chars")
    .action(async (symbol, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as Record<string, string | boolean | undefined>;
      process.exitCode = await order.placeCmd(
        contextFrom(p),
        {
          symbol,
          side: o["side"] === "sell" ? "sell" : "buy",
          size: String(o["size"] ?? "0"),
          price: o["price"] === undefined ? undefined : String(o["price"]),
          spot: o["spot"] === true,
          reduceOnly: o["reduceOnly"] === true,
          tif: (o["tif"] ?? "Gtc") as order.Tif,
          triggerPx: o["triggerPx"] === undefined ? undefined : String(o["triggerPx"]),
          triggerKind: o["triggerKind"] === "sl" ? "sl" : "tp",
          marketTrigger: o["marketTrigger"] === true,
          cloid: o["cloid"] === undefined ? undefined : String(o["cloid"]),
        },
        outOf(p, write),
      );
    });

  ord
    .command("cancel")
    .argument("<symbol>")
    .argument("<oid>", "order id")
    .option("--fast", "fast cancel (rejects trigger orders)", false)
    .action(async (symbol, oid, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      process.exitCode = await order.cancelCmd(
        contextFrom(p),
        { symbol, oid: Number(oid), fast: (opts as { fast?: boolean }).fast === true },
        outOf(p, write),
      );
    });

  ord
    .command("cancel-by-cloid")
    .argument("<symbol>")
    .argument("<cloid>", "0x + 32 hex chars")
    .option("--fast", "fast cancel", false)
    .action(async (symbol, cloid, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      process.exitCode = await order.cancelByCloidCmd(
        contextFrom(p),
        { symbol, cloid, fast: (opts as { fast?: boolean }).fast === true },
        outOf(p, write),
      );
    });

  ord
    .command("cancel-all")
    .argument("[symbol]", "restrict to one market")
    .option("--fast", "fast cancel", false)
    .action(async (symbol, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      process.exitCode = await order.cancelAllCmd(
        contextFrom(p),
        { symbol, fast: (opts as { fast?: boolean }).fast === true },
        outOf(p, write),
      );
    });

  ord
    .command("modify")
    .argument("<oid>", "order id to replace")
    .option("--price <n>", "new limit price")
    .option("--size <n>", "new size")
    .option("--tif <tif>", "new tif")
    .option("--always-place", "re-cross even if it would immediately fill", false)
    .action(async (oid, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as Record<string, string | boolean | undefined>;
      process.exitCode = await order.modifyCmd(
        contextFrom(p),
        {
          oid: Number(oid),
          price: o["price"] === undefined ? undefined : String(o["price"]),
          size: o["size"] === undefined ? undefined : String(o["size"]),
          tif: o["tif"] === undefined ? undefined : (String(o["tif"]) as order.Tif),
          alwaysPlace: o["alwaysPlace"] === true,
        },
        outOf(p, write),
      );
    });

  ord
    .command("schedule-cancel")
    .description("dead-man switch: cancel everything at a future time, or --clear to disarm")
    .option("--at <iso>", "ISO 8601 time, at least 5s ahead")
    .option("--clear", "disarm the switch", false)
    .action(async (opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as { at?: string; clear?: boolean };
      process.exitCode = await order.scheduleCancelCmd(contextFrom(p), { at: o.at, clear: o.clear === true }, outOf(p, write));
    });

  const mar = program.command("margin").description("leverage and isolated margin");
  mar
    .command("leverage")
    .argument("<symbol>")
    .argument("<leverage>", "target leverage, integer")
    .option("--cross", "cross margin", false)
    .option("--isolated", "isolated margin", false)
    .action(async (symbol, leverage, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as { cross?: boolean; isolated?: boolean };
      process.exitCode = await margin.leverageCmd(
        contextFrom(p),
        { symbol, leverage: Number(leverage), cross: o.cross === true, isolated: o.isolated === true },
        outOf(p, write),
      );
    });
  mar
    .command("add")
    .argument("<symbol>")
    .argument("<usd>", "USDC amount, e.g. 25")
    .option("--side <s>", "long or short", "long")
    .action(async (symbol, usd, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      process.exitCode = await margin.addMarginCmd(
        contextFrom(p),
        { symbol, usd: Number(usd), side: (opts as { side: string }).side === "short" ? "short" : "long" },
        outOf(p, write),
      );
    });
  mar.command("top-up").argument("<symbol>").argument("<leverage>").action(async (symbol, leverage, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await margin.topUpCmd(contextFrom(p), { symbol, leverage: Number(leverage) }, outOf(p, write));
  });

  const tw = program.command("twap").description("time-weighted average price orders");
  tw.command("place")
    .argument("<symbol>")
    .option("--side <side>", "buy or sell", "buy")
    .option("--size <n>", "total size, decimal string", "0")
    .option("--minutes <m>", "duration in minutes", "60")
    .option("--randomize", "randomise slice timing", false)
    .action(async (symbol, opts, cmd: Command) => {
      const p = globalsFor(cmd);
      const o = opts as Record<string, string | boolean | undefined>;
      process.exitCode = await twap.twapPlaceCmd(
        contextFrom(p),
        {
          symbol,
          side: o["side"] === "sell" ? "sell" : "buy",
          size: String(o["size"] ?? "0"),
          minutes: Number(o["minutes"] ?? "60"),
          randomize: o["randomize"] === true,
        },
        outOf(p, write),
      );
    });
  tw.command("cancel").argument("<symbol>").argument("<twapId>").action(async (symbol, twapId, cmd: Command) => {
    const p = globalsFor(cmd);
    process.exitCode = await twap.twapCancelCmd(contextFrom(p), { symbol, twapId: Number(twapId) }, outOf(p, write));
  });
}
