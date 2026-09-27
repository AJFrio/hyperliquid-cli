# hyperliquid-cli

An agent-first command line client for [Hyperliquid](https://app.hyperliquid.xyz).

It exposes the exchange's market data, account state and trading actions with a
contract designed to be driven by an LLM agent rather than a human at a
terminal: **JSON on stdout, structured JSON errors on stderr, and meaningful exit
codes.** No colours, no spinners, no interactive prompts on any code path.

```console
$ hyperliquid market mids BTC
{
  "BTC": "84409.5"
}

$ hyperliquid market mids NOTACOIN; echo "exit=$?"
{
  "error": {
    "code": "UNKNOWN_ASSET",
    "message": "unknown market: NOTACOIN",
    "details": { "symbol": "NOTACOIN" }
  }
}
exit=2
```

## Install

Install from this repository. The package is not published to npm.

```bash
git clone https://github.com/AJFrio/hyperliquid-cli.git
cd hyperliquid-cli
npm install
npm run build
npm install -g .
hyperliquid --version
hl --version
```

Requires Node.js 20.11 or newer. The Hyperliquid TypeScript SDK
(`@nktkas/hyperliquid`) is the maintained one — the older `hyperliquid-ts`
package has been stale since 2024 and is not used.

## Output contract

This is the part that matters if you are an agent. Treat it as an API.

| Situation | stdout | stderr | exit code |
|---|---|---|---|
| success | JSON document (or a table with `--table`) | empty | `0` |
| bad flag, unknown market, malformed key | empty | `{"error":{"code","message","details"}}` | `2` |
| network failure, API error, exchange rejection | empty | `{"error":{"code","message","details"}}` | `1` |

Nothing is ever written to stdout on failure, so a consumer can pipe stdout
straight into a JSON parser without ever seeing a half-written document.

Error `code` is stable and safe to branch on: `USAGE`, `UNKNOWN_ASSET`,
`INVALID_INPUT`, `NOT_CONFIGURED`, `API_ERROR`, `NETWORK_ERROR`,
`EXCHANGE_REJECTED`, `UNSUPPORTED`, `INTERNAL`.

### Global flags

| Flag | Effect |
|---|---|
| `--testnet` | use the testnet deployment |
| `--dry-run` | sign and print the envelope, do **not** POST to `/exchange` |
| `--table` | human-readable table instead of JSON |
| `-q, --quiet` | suppress stdout entirely |
| `--config-dir <path>` | use an isolated config/credential directory |

## Setup

Hyperliquid uses a two-wallet model, and you need **two** values — this is the
single most common thing people get wrong:

- the **agent private key**, which signs orders. This is the secret.
- the **account address** (your master or sub-account), which owns the positions
  and balance. This is public, and it is **not derivable** from the agent key.

An *address* cannot sign anything. Run `hl init` for guided onboarding. It asks
for the account address, optionally checks the API wallet address, and collects
the API wallet private key in a hidden terminal prompt:

```bash
hl init
```

The API wallet address is checked against the address derived from its private
key. The key is never accepted as a command-line value, because argv is visible
in shell history and in `ps`. For scripted setup, use `--key-file` or the
environment:

```bash
export HLCLI_AGENT_PRIVATE_KEY=0x...
hyperliquid init --account 0xYourMasterOrSubAccountAddress --agent-address 0xYourApiWalletAddress
```

Alternatively, provide `--key-file <path>`. Once configured, later invocations
reuse the stored key and never prompt. `hl` and `hyperliquid` run the same CLI.

### Registering the agent

The agent key must be approved by the account's **master** key before it can
trade. This is a signed Hyperliquid action, not an on-chain Arbitrum
transaction, so nothing is broadcast to Arbitrum:

```bash
hyperliquid agent approve --master-key-file ./master.key
```

The master key is used once, is never written to the config or the key store,
and cannot be passed as a flag. Add `--dry-run` to inspect the envelope first.

## Security

The agent key can place, modify and cancel orders. Treat this tool as a
hot-wallet client.

- **OS keychain first.** The key goes to the platform keychain
  (macOS Keychain / Windows Credential Manager / Linux Secret Service) via
  `@github/keytar`, a maintained fork — the original `keytar` has been archived
  since 2022 and has a known Linux crash. GitHub's own guidance now explicitly
  favours the OS keychain in an agentic context, for exactly this reason.
- **Encrypted file fallback** for headless machines, using
  scrypt (`N=2^17, r=8, p=1`) and AES-256-GCM, written `0600` via a
  temp-file + `fsync` + `rename` sequence so a crash cannot leave a torn key.
  The scrypt parameters are recorded in the file so the cost factor cannot
  silently regress.
  The encrypted file is used only when the OS keychain is unavailable. Note
  the honest limit: this fallback protects the key from accidental
  disclosure (backups, stray greps, a synced directory). It does not protect
  against code already running as your user. That is why the keychain is the
  default.
- **Keychain entries are namespaced by config directory**, so a sandbox used for
  testing can never read your real trading key.
- **Secrets never reach output.** Keys are only ever printed masked
  (`0x1234...abcd`). `--dry-run` truncates signature components so a transcript
  is not a replayable artifact.
- **Key precedence** is `HLCLI_AGENT_PRIVATE_KEY` > OS keychain > encrypted
  file, so CI and agents can inject a key without touching your real one.
- The config file holds no secret material. Only the account address, the
  derived agent address, the network and which backend is in use.

## What is implemented

Everything the web app can do to **read** data and to **trade**:

| Area | Commands |
|---|---|
| Market data | `market mids`, `list`, `ticker`, `candles`, `trades`, `book`, `funding`, `status` |
| Account | `account state`, `spot`, `orders`, `order-status`, `fills`, `funding`, `ledger`, `rate-limit`, `role` |
| Orders | `order place`, `cancel`, `cancel-by-cloid`, `cancel-all`, `modify`, `schedule-cancel` |
| Margin | `margin leverage`, `add`, `top-up` |
| TWAP | `twap place`, `cancel` |
| Setup | `init`, `config show`, `config remove`, `agent approve`, `agent status` |

Perpetual and spot markets are both supported, including HIP-3 builder perps
(`dex:COIN`).

### Deliberately not implemented

**Fund movements are omitted on purpose.** There is no `withdraw`, `usdSend`,
`spotSend`, `sendAsset`, `usdClassTransfer`, `vaultTransfer`, `tokenDelegate` or
`claimRewards` command. These move real money irreversibly, need the master key
rather than the agent key, and are the highest-value target for a
prompt-injected or hallucinating agent. Deposits are still available through
the official web app and API.

A test walks the whole command tree and fails if any fund-movement verb ever
appears, so this cannot regress.

Prediction-market instruments (the `#<id>` keys that appear in the price feed
with values between 0 and 1) are also omitted: they have no metadata endpoint
that names them, so they cannot be presented honestly.

## Examples for agents

```bash
# What does BTC cost, and how is it trending? (no credentials needed)
hyperliquid market ticker BTC
hyperliquid market candles BTC --interval 15m --start 1789000000000 --end 1790460000000

# Review an order without sending it
hyperliquid --dry-run order place BTC --side buy --size 0.01 --price 50000

# Place for real
hyperliquid order place BTC --side buy --size 0.01 --price 50000 --cloid 0x$(openssl rand -hex 16)

# Inspect, then cancel everything
hyperliquid account orders
hyperliquid order cancel-all

# Dead-man switch: cancel all if the bot stops checking in
hyperliquid order schedule-cancel --at 2026-01-01T00:00:00Z
hyperliquid order schedule-cancel --clear
```

Always prefer `--dry-run` first. It produces the exact signed envelope and
posts nothing.

## Notes on the exchange API

Behaviours this client works around, all verified against the live API rather
than the published documentation, which is out of date in several places:

- Errors come back as `Content-Type: text/plain`, not JSON. A naive
  `response.json()` throws an opaque `SyntaxError` and loses the real message,
  so responses are read as text and then parsed.
- `assetCtxs` and `spotAssetCtxs` are no longer info types; use
  `metaAndAssetCtxs` and `spotMetaAndAssetCtxs`.
- `candleSnapshot` responses are capped (~5000 candles) and history is pruned.
  A wide window can return fewer rows, or none, with HTTP 200. This client
  always reports `returned`, `availableInWindow`, `truncated` and `empty` so
  under-delivery is never silent.
- `allMids` mixes three namespaces in one flat object — perp names, `@<index>`
  spot pairs, and opaque `#<index>` keys — and includes delisted instruments.
  Symbols are therefore always resolved against `meta.universe` /
  `spotMeta.universe`, never against mid keys.
- `predictedFundings` is multi-venue (`BinPerp` / `HlPerp` / `BybitPerp`) with
  per-venue intervals, and 69 of 702 venue entries are currently `null`.
- Spot asset ids are `10000 + spotMeta.universe[i].index`; HIP-3 ids are
  `100000 + dexIndex*10000 + index`. Ids differ between mainnet and testnet and
  are never cached across networks.
- `cancel.f`, `cancelByCloid.f`, `modify.a` and `batchModify.a` are optional
  booleans that must be **absent** when false. `canonicalize()` does not strip
  them, so this client does, and there is a regression test for each.
- Actions are renamed: `order` (not `placeOrder`), `twapOrder`/`twapCancel`,
  `spotSend`, `withdraw3`, `approveAgent`. There is no `batchPlaceOrders` — the
  `order` action takes an array.
- There is no dry-run or simulation mode in any SDK. `--dry-run` here is built
  on top of the signing primitives.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run lint
npm run fixtures   # re-capture offline fixtures from the live public API
```

Tests are offline for the read path (against committed fixtures captured from
the live API) and use `--dry-run` for anything that would sign, so the suite
can never place a real order. CI runs on Node 22 and 24.

See [AGENTS.md](AGENTS.md) for the machine-facing command contract and
[CONTRIBUTING.md](CONTRIBUTING.md) for the TDD workflow.

## Licence

MIT
