# Contributing

## Setup

```bash
npm install
npm run typecheck && npm test && npm run build && npm run lint
```

## Test-driven workflow

Every behaviour change follows RED → GREEN → SURFACE.

1. **RED.** Write the failing test first. Run it. Confirm it fails for the right
   reason — not a syntax error, not a bad import.
2. **GREEN.** Smallest change that flips the test. If it needs many lines, the
   test was too coarse; split it.
3. **SURFACE.** Exercise the real command and check the actual exit code and
   stdout/stderr, not just the assertion.

## Testing rules

- Read-path tests run offline against `fixtures/`, captured from the live public
  API with `npm run fixtures`. Review the diff: an unexpected shape change is a
  signal.
- Anything that would sign must go through `--dry-run`. **The suite must never
  place a real order.**
- Tests must not write to the real OS keychain. Pin
  `HLCLI_STORAGE_BACKEND=file` and use a temp `HLCLI_CONFIG_DIR`.
- Use throwaway keys only, e.g. `0x` followed by 64 repeated hex digits.

## Code rules

- Strict TypeScript. No `any`, no `@ts-ignore`, no non-null assertions on
  unvalidated input.
- Keep modules under 250 pure lines; split by responsibility.
- Validate at every boundary with Zod.
- Use `exactOptionalPropertyTypes`; spread conditionally rather than assigning
  `undefined`.

## Exchange API gotchas

These are verified against the live API and are not obvious from the published
docs. Do not regress them.

- Errors are `text/plain`, not JSON. Read text, then try to parse.
- `cancel.f`, `cancelByCloid.f`, `modify.a` and `batchModify.a` must be **absent**
  when false. `canonicalize()` keeps them, so strip them explicitly.
- Canonicalise every action with the SDK's valibot schema. msgpack key order
  affects the hash, and hand-built objects get rejected signatures.
- Never resolve symbols against `allMids`.
- Spot asset id is `10000 + index`; HIP-3 is `100000 + dexIndex*10000 + index`.
- `candleSnapshot` is capped and pruned; report truncation.
- `predictedFundings` venue entries can be `null`.

## Commits

One atomic commit per verified increment, with the evidence in the message body.
Mirror the existing style: `feat(scope): imperative summary`.
