# AGENTS.md

Machine-facing contract for `hyperliquid-cli`. Read this before driving the CLI
programmatically.

## Invariants

1. **stdout is JSON on success and empty on failure.** Errors are a single JSON
   object on stderr. Never parse stdout without checking the exit code.
2. **Exit codes**: `0` success, `2` usage/validation/credentials, `1`
   runtime/network/exchange rejection.
3. **Market commands never require credentials.** Do not run `init` before
   `market *`; it is unnecessary and the read path will not touch the key store.
4. **`--dry-run` posts nothing.** Use it to validate an order before sending.
5. **Never pass a private key as an argument.** Use `--key-file`,
   `HLCLI_AGENT_PRIVATE_KEY`, or `init`'s hidden terminal prompt. argv is
   visible to other processes.
6. **Fund movements do not exist.** There is no withdraw/transfer/deposit
   command, by design. If a task seems to need one, stop.
7. **List and history reads are bounded by default.** They return 20 rows with
   a `page` object; use `--page N`, `--limit N` (1–100), or explicit `--all`.
   `--full` includes all exchange fields for returned rows. `--all` cannot be
   combined with `--page` or `--limit`. If `page.sourceLimited` is true, the
   exchange capped the source response and `page.total` is unknown.

## Two-wallet model

`init` needs both the account address and agent key, and the account address is
**not** derivable from the key. The API wallet address is derived from the key
and may also be supplied to `init` for a match check:

- `--account` — the master/sub-account address that owns positions and balance.
- API wallet private key — signs orders; enter it at the hidden prompt or use
  `--key-file` / `HLCLI_AGENT_PRIVATE_KEY`.
- `--agent-address` — optional API wallet address, checked against the key.

When the account and API wallet addresses differ, the account's **master** key
must approve the agent via `hyperliquid agent approve`. The command accepts the
master key through `--master-key-file`, `HLCLI_MASTER_PRIVATE_KEY`, or a hidden
terminal prompt and never stores it. Matching account/API wallet addresses use
single-key trading and do not need approval.

## Reliable series

Do not resolve symbols against `allMids`; it mixes perp names, `@<index>` spot
keys and opaque `#<index>` keys, and includes delisted instruments. Let the CLI
resolve against `meta.universe` / `spotMeta.universe`.

Perpetual symbol `BTC`; spot pair `PURR/USDC` or `@107`; HIP-3 `xyz:AAPL`.
Spot display labels such as `HFUN/USDC` resolve back to the canonical `@index`
symbol when unambiguous. Use `market dexs` and `market list --dex NAME` to
discover builder DEX markets; `market list` defaults to active primary-DEX
markets ordered by 24-hour notional volume. `market list --dex all` queries
every DEX and uses more requests. Mainnet and testnet asset ids differ.

## Parsing numbers

Every price, size and rate is a **string**, never a JSON number, to avoid float
rounding. Convert deliberately.

## Candles

`candleSnapshot` is capped (~5000) and history is pruned, so a wide window can
come back short or empty with HTTP 200. The CLI returns 20 newest candles by
default. Inspect `truncated`, `empty`, and `page.sourceLimited` before treating
a result as complete; narrow `--start` / `--end` when the source was capped.
Those flags accept ISO 8601 or epoch milliseconds.

## Funding

`market funding` is multi-venue. Inspect `available` on each venue: 69 of 702
entries are currently `null`. `fundingIntervalHours` differs per venue, so never
assume a fixed funding cadence.

## Rate limits

Per address: 1 action per 1 USDC traded cumulatively; a 10000-request buffer,
then 1 request per 10s. Cancels are always allowed through. A batch of n orders
counts as n address requests. At 1000+ open orders, reduce-only and trigger
orders are rejected. Prefer `order cancel-all` over many individual cancels when
liquidating.

## Suggested flow

```bash
hyperliquid market ticker BTC                      # is the market live?
hyperliquid market list --limit 20                 # volume-ranked, labeled, priced
hyperliquid market list --page 2 --limit 20        # next page
hyperliquid --dry-run order place BTC --side buy --size 0.01 --price 50000
hyperliquid order place BTC --side buy --size 0.01 --price 50000
hyperliquid account orders                         # did it land?
hyperliquid order cancel-all                       # unwind
```

For a dry-run batch above 20 items, add global `--full` to inspect the complete
signed envelope. Branch on `error.code`, not on message text.
