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
5. **Never pass a private key as an argument.** Use `--key-file` or
   `HLCLI_AGENT_PRIVATE_KEY`. argv is visible to other processes.
6. **Fund movements do not exist.** There is no withdraw/transfer/deposit
   command, by design. If a task seems to need one, stop.

## Two-wallet model

`init` needs both values, and the account address is **not** derivable from the
key:

- `--account` — the master/sub-account address that owns positions and balance.
- agent private key — signs orders.

The agent key only works after the account's **master** key approves it via
`hyperliquid agent approve`.

## Reliable series

Do not resolve symbols against `allMids`; it mixes perp names, `@<index>` spot
keys and opaque `#<index>` keys, and includes delisted instruments. Let the CLI
resolve against `meta.universe` / `spotMeta.universe`.

Perpetual symbol `BTC`; spot pair `PURR/USDC` or `@107`; HIP-3 `xyz:AAPL`.
Mainnet and testnet asset ids differ.

## Parsing numbers

Every price, size and rate is a **string**, never a JSON number, to avoid float
rounding. Convert deliberately.

## Candles

`candleSnapshot` is capped (~5000) and history is pruned, so a wide window can
come back short or empty with HTTP 200. Always inspect `truncated` and `empty`
before treating a result as complete. `--start` / `--end` accept ISO 8601 or
epoch milliseconds.

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
hyperliquid --dry-run order place BTC --side buy --size 0.01 --price 50000
hyperliquid order place BTC --side buy --size 0.01 --price 50000
hyperliquid account orders                         # did it land?
hyperliquid order cancel-all                       # unwind
```

Branch on `error.code`, not on message text.
