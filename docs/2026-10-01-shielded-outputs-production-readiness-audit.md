# Shielded Outputs / Confidential Transactions — Production Readiness Audit

- **Date:** 2026-10-01
- **Subject:** `origin/master` @ `597fc37` (hathor-wallet-service)
- **Verdict:** **NOT production ready.** The feature is structurally complete and
  well-built, but it does not function end to end: no confidential-transaction crypto
  provider is registered at runtime, so every shielded output of every wallet fails
  recovery and reads as a zero balance. Several of the gaps around that are
  independently shippable blockers.

---

## 1. What is landed

Every shielded PR is merged to `master`. There is **no unlanded shielded source code**:
I diffed `packages/*/src` and `db/migrations` for each remaining shielded branch against
`origin/master` and the trees are identical (`feat/shielded-outputs-wallet-api`,
`…-wallet-registration-2-combined-load`: empty diff; `…-daemon-9-integration`: only the
already-superseded `total_supply` migration). Master *is* the complete state of the feature.

| PR | Title | Merged |
|---|---|---|
| #439 | shielded-outputs: foundations (1/6) | 2026-06-29 |
| #469 | remove unused `total_supply` tracking and `tx_output` indexes | 2026-07-01 |
| #473 | wallet registration core | 2026-07-09 |
| #474 | wallet registration request + reconciliation | 2026-07-16 |
| #475 | combined transparent+shielded wallet load | 2026-07-22 |
| #477 | shielded balances, history, utxos and addresses on wallet API | 2026-07-23 |
| #496 | CI: deploy Lambdas to `testnet-shielded-outputs` on RCs and releases | 2026-10-01 |

Prerequisites that are done (and that older project notes still list as pending):
`@hathor/wallet-lib` is on **4.0.0** in every package, and `reconstructWallet`-style
reconstruction **is** wired into the load path (`api/wallet.ts:826-832`), outside the DB
transaction, with a two-pass settle drain.

---

## 2. The blocker: no crypto provider is registered

`packages/common/src/crypto/ctRewind.ts` is a registration seam. `provider` starts as
`null` (`:72`) and `requireProvider()` throws `RewindError('shielded crypto provider not
registered')` (`:84-89`).

A repo-wide search for `setShieldedCryptoProvider` outside `node_modules` returns the
definition plus **three test files only**:

- `packages/daemon/__tests__/mocks/ct-crypto-node.ts:92`
- `packages/wallet-service/tests/utils/ct-crypto-mock.ts:82`
- `packages/common/__tests__/crypto/ctRewind.test.ts` (4 call sites)

**Zero production call sites.** No `package.json` depends on `@hathor/ct-crypto-node` or
`@hathor/ct-crypto-wasm`; only the interface-only `@hathor/ct-crypto-provider@0.0.1-shielded`
is declared (`packages/common/package.json:16`). So at runtime both `rewindAmount` and
`rewindFully` throw on every shielded output, on both the daemon and the wallet-service.

### 2.1 The upstream gap is packaging only

I pulled all three published tarballs and compared them:

| `@hathor/ct-crypto-node` | `./provider` subpath export | prebuilds shipped |
|---|---|---|
| `0.0.1-shielded` | ✅ `createDefaultShieldedCryptoProvider()` → `NodeShieldedProvider extends AbstractShieldedProvider` | ❌ `darwin-arm64` only |
| `0.3.0` | ❌ | (not inspected in detail) |
| `0.4.0` (`latest`) | ❌ no `provider.js`, no `exports` map, no `@hathor/ct-crypto-provider` dep | ✅ `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` |

The two `index.d.ts` files are **byte-identical** (`diff` clean), and both export the same
28 NAPI primitives — including every primitive `provider.js` delegates to
(`rewindAmountShieldedOutput`, `rewindFullShieldedOutput`, `deriveTag`, `deriveAssetTag`,
`createCommitment`, `createAssetCommitment`, `createSurjectionProof`,
`computeBalancingBlindingFactor`, `deriveEcdhSharedSecret`, …).

**So no new cryptography is needed upstream.** The blocking request to the
`hathor-ct-crypto` repo is: publish a `@hathor/ct-crypto-node` (e.g. `0.5.0`) that is
`0.4.0`'s prebuilds plus `0.0.1-shielded`'s `provider.js`, its `"./provider"` exports
entry, and its `@hathor/ct-crypto-provider` dependency. That is a packaging change.

Note `@hathor/ct-crypto-wasm` is **verifier-only** — `AbstractShieldedProvider` itself says
so (`lib/abstract.js:155-156`) — so it is not a substitute for the rewind path.

### 2.2 Native-addon packaging is an untested deployment risk

Lambdas are bundled by `serverless-webpack` with `webpack-node-externals` and
`includeModules: true` (`packages/wallet-service/webpack.config.js:40-43`,
`serverless.yml:12-15`). `ct-crypto-node` is a NAPI native addon that resolves a
`prebuilds/<platform>-<arch>/ct-crypto.node` binary at require time. Whether that binary
survives the webpack-externals → `includeModules` packaging path into the Lambda artifact,
and whether the Lambda `nodejs22.x` runtime arch matches the shipped prebuild, is unverified
— nothing can test it until the dependency is actually added.
---

## 3. Wallet-service: API, registration and load

Audited against `packages/wallet-service/src` at `597fc37`.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **W1** | BLOCKER | No provider registered ⇒ every shielded output of every wallet lands `recovery_failed` and reads as zero; wallet still flips READY | `common/src/crypto/ctRewind.ts:70-89`; `api/wallet.ts:837-843` |
| **W2** | HIGH | **No re-drive path for a READY wallet.** Recovery sweeps run only inside `loadWallet`; a same-keys resubmit on a READY wallet is a no-op | `api/wallet.ts:610-621`, `:826-843`; `shieldedRecovery.ts:128` has no caller outside `loadWallet` |
| **W3** | HIGH | **CTSpend address window never grows.** Derived once at registration; nothing extends it as shielded indices get used ⇒ outputs past the window are unowned forever and `/addresses/new?legacy=false` drains to empty | `db/shielded.ts:522-594` (only derivation site); daemon `services/index.ts:671-674` marks it follow-up |
| **W4** | HIGH | `POST /tx/proposal` **accepts a recovered shielded UTXO** as an input (guard admits `recovery_state='recovered'`), locks it under the proposal, and returns a wrong derivation path (`/0'/` for an account-2 address) | `db/index.ts:1021-1041`; `api/txProposalCreate.ts:103,153,157` |
| **W5** | MEDIUM | Legacy-client trap: `/wallet/balances` **merges** shielded into `unlocked`/`locked` by default; default `/wallet/utxos` and `/wallet/tx_outputs` return merged rows; `totalAmount` silently forces transparent. An old client shows a balance it cannot spend | `types.ts:485-495`; `api/txOutputs.ts:240-242`; `db/index.ts:2701` |
| **W6** | MEDIUM | `GET /wallet/transactions/{txId}` reads only `wallet_tx_history.balance`, dropping `shielded_balance_delta` ⇒ a shielded-only tx reports `balance: 0`, contradicting `/wallet/history` | `db/index.ts:3213-3240` vs `:1634-1676` |
| **W7** | MEDIUM | Recovery failure is **invisible to the client**: status `ready`, balances exclude the output, `txId+index` lookup returns `200 []`. No "pending recovery" signal anywhere | `api/wallet.ts:837-843`; `db/index.ts:958`; `api/txOutputs.ts:200-229` |
| **W8** | MEDIUM | API contract undocumented — `api-docs.json` has **zero** shielded mentions (`split`, `kind`, `legacy`, `tx_kind`, `balanceBreakdown`, shielded `TxOutputEntry`, init fields, 409 `shielded-keys-conflict`) | `src/api-docs.json`; `README.md` |
| **W9** | LOW | Six unguarded `tx_output` readers still do raw `BigInt(result.value)`; all dead in the deployed service, one wiring mistake from a `TypeError` | `db/index.ts:982,1057,1132,1693,2140,2209` |
| **W10** | LOW | `reconstructWallet` is dead code — `loadWallet` inlines a different sequence; the doc comment at `wallet.ts:769` still names it | `shieldedRecovery.ts:161-179` vs `api/wallet.ts:822-868` |
| **W11** | LOW | Key purpose/depth not validated, and keys are immutable per wallet (409 forever) ⇒ a client that registers keys at the wrong path needs ops to recover | `api/wallet.ts:246-284`, `:589-595` |
| **W12** | LOW | `scan_xpriv` and per-index `scan_privkey` stored plaintext ⇒ a DB read is total amount/token privacy loss for every shielded wallet (not spend authority). By design, but it is the blast radius | `db/index.ts:299-301`; `db/shielded.ts:449` |
| **W13** | LOW | Concurrent first-time `POST /wallet/init` for the same xpub: loser's INSERT dup-keys → 500 (pre-existing for legacy) | `api/wallet.ts:446-538` |
| **W14** | LOW | `/wallet/tx_outputs?txId&index` is an existence oracle (403 vs `200 []`). Pre-existing, now also covers shielded rows | `api/txOutputs.ts:200-208` |

### What an end user can actually do today

Register shielded keys (fresh or upgrading a legacy wallet) and get a READY wallet; list CT
addresses and unused CT addresses; hand a CT address to a payer. The daemon records the
output that arrives — and then recovery throws, so it is marked `recovery_failed`:
`/wallet/balances` shows `shielded: 0`, `/wallet/history` shows nothing for it,
`/wallet/tx_outputs?txId&index` returns an empty list, and `/wallet/status` says `ready`.
Nothing the user does afterwards re-runs recovery (W2), so **even after the provider ships,
wallets registered before it stay at zero until ops intervene**. Exhausting the ~20-address
CT window makes further receives permanently unowned (W3). Spending a shielded UTXO is
impossible; attempting it via `/tx/proposal` returns 201 with a wrong path and locks the
UTXO (W4). Nothing 500s on the shielded read paths.

### What is solid here

- SQL-level `mode`/`recovery_state` guards on **every client-reachable** `tx_output` read,
  plus a loud-fail mapper (`db/index.ts:2726-2733`) rather than silent `?? 0` coercion.
- Registration proof chain: neutered spend xpub, private scan key enforced, matched-pair
  index-0 CT address check, spend-key self-signature, auth-key consent signature with
  timestamp anti-replay, immutable keys with a clean 409, no key material in any response.
- Load lifecycle: CAS-guarded retry/attach, atomic retry bumps, DLQ pinning that will not
  demote a recovered wallet, upgrade failure leaving the legacy side working, absolute
  rebuilds under `SELECT … FOR UPDATE`, keyset-paged sweeps that cannot spin on a
  repeatedly-failing row, crash containment in both the per-output and whole-load paths.
- Daemon/service coordination via `isWalletAttributable` + the `unowned`-only recovery mark
  avoids double-crediting during a concurrent load.
- Read responses carry explicit discriminators (`kind`, `tx_kind`, `split`) and degrade with
  an alert instead of a 500 on partial shielded data, with tests pinning that.
---

## 4. Daemon: ingest and void/reorg

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **D1** | BLOCKER | **HTR amount-shielded rewind is handed a 1-byte `tokenUid`.** `resolveShieldedTokenId` returns `NATIVE_TOKEN_UID` (`'00'`), so `Buffer.from('00','hex')` is 1 byte where `rewindAmount` documents a 32-byte uid feeding the asset generator. Every owned HTR amount-shielded output fails recovery **even with a working provider**. Custom tokens are fine (already 64-hex). The mode-2 path is correct — `rewindFully` normalizes outbound; only the inbound mapping is missing | `daemon/src/services/index.ts:451-457, 533-544`; `common/src/crypto/ctRewind.ts:58-59`; wallet-lib `constants.js:151` vs `:156` |
| **D2** | BLOCKER | **`recovery_failed` is terminal in practice.** The daemon has no re-drive at all (`grep catchup_state` over `daemon/src` → two comments, zero code), and its `markTxOutputRecovered` is guarded `AND recovery_state = 'unowned'`, so it **provably cannot promote** a `recovery_failed` row — it returns `affectedRows = 0` and writes neither `value` nor `token_id`, silently. The wallet-service's near-duplicate uses the correct `<> 'recovered'` guard | `daemon/src/db/index.ts:500-538` (`:509`); `services/index.ts:525`; cf. `wallet-service/src/db/shielded.ts:92-96` |
| **D3** | HIGH | No-provider steady state is one `Severity.MAJOR` alert **per failed output**, awaited serially post-commit with a fresh `SQSClient` each. At `MAX_SHIELDED_OUTPUTS = 32` that is up to 32 sequential SQS round-trips before `handleVertexAccepted` resolves — it both floods paging **and throttles sync** | `services/index.ts:576-580, 792-800`; `common/src/utils/alerting.utils.ts:46-62` |
| **D4** | HIGH | **Void ordering can crash-loop the daemon.** A shielded spend's reversal is sourced from a DB read gated `voided = FALSE`. Void the funding vertex first and the `+v` restore never happens; on `BIGINT UNSIGNED` under strict mode the subtraction raises `ER_DATA_OUT_OF_RANGE` → throw inside the void transaction → `SYNC_MACHINE_STATES.ERROR` (`type: 'final'`) → `process.exit(1)` → restart → replay same event → **crash loop**. The transparent path is immune because it reads the value off the wire | `utils/wallet.ts:334-344` → `db/index.ts:752-760`; `SyncMachine.ts:298, 391-395`; `src/index.ts:27-30` |
| **D5** | HIGH | `ct_status = 'error'` makes a wallet permanently non-attributable for **all** wallet-grain writes — including pure transparent ones. A shielded registration failure silently stops the wallet's ordinary transparent balance updates | `types/wallet.ts:38-43`; `utils/wallet.ts:474-483` |
| **D6** | HIGH | **No CTSpend gap extension.** `getMaxIndicesForWallets` correctly computes the CT index pair — then the consumer destructures only the legacy fields and discards it. The daemon never reads `spend_xpub`, `scan_xpriv`, `shielded_max_gap` or `last_used_shielded_index` (zero hits in `daemon/src`), and `getAddressWalletInfo` doesn't even select them. Schema, index query and gap parameter exist; derivation and writer do not | `services/index.ts:671-691`; `db/index.ts:2467-2496`, `:1448-1454`; `types/wallet.ts:16-27` |
| **D7** | HIGH (SUSPECTED) | `headers[]` is typed **nano-only** (`EventTxHeaderSchema = EventTxNanoHeaderSchema`). wallet-lib 4.0.0 defines six header ids — nano `10`, FEE `11`, SHIELDED_OUTPUTS `12`, UNSHIELD_BALANCE `13`, MINT `14`, MELT `15`. If the fullnode emits any non-nano header, Zod parse fails → throw in `socket.onmessage` → crash loop, and no shielded mint/melt vertex can ever be ingested. Hasn't bitten because the current fullnode flattens shielded outputs to a top-level field. **Needs a 30-minute check against hathor-core's serializer; could be a BLOCKER** | `types/event.ts:196-199, 214`; `actors/WebSocketActor.ts:74-80`; wallet-lib `headers/types.js:20-27` |
| **D8** | MEDIUM | Shielded mint/melt not read at all, and `incrementTokensTxCount` is fed transparent-only token lists. A shielded-only receive of custom token T bumps nothing and, if T has no `token` row, leaves balance rows whose symbol lookup returns blank (so push renders an empty symbol). `total_supply`/`applyTokenSupplyUpdates` were **deleted** — the wallet-service now reads supply live from the fullnode, so there is no supply consequence | `services/index.ts:604-608`; `utils/wallet.ts:592-604`; `db/migrations/20260629100000-…:19`; `wallet-service/src/api/tokens.ts:94` |
| **D9** | MEDIUM | **Zod has no size caps** on `range_proof`/`surjection_proof`/`script`/`token_data`, though wallet-lib publishes the exact ones the DB was built to (`MAX_RANGE_PROOF_SIZE` 3328, `MAX_SURJECTION_PROOF_SIZE` 4096, `MAX_SHIELDED_OUTPUT_SCRIPT_SIZE` 1024). Against `script VARBINARY(1024)` (zero headroom) and `token_data TINYINT UNSIGNED`, an over-cap field raises `ER_DATA_TOO_LONG` inside the ingest transaction → permanent halt. `.max()` alone doesn't buy availability — a parse failure crash-loops too; the real fix is a quarantine path | `types/event.ts:134-152`; `db/migrations/20260512100001-…:30-37`; wallet-lib `constants.js:248-278` |
| **D10** | MEDIUM | Void **recomputes** the shielded receive set from *current* `recovery_state` rather than from what ingest wrote. If a row went `unowned → recovered` in between (which the wallet-service catch-up does), void subtracts a credit the daemon never added and decrements `address_balance.transactions` for a pair it never incremented — possible `INTEGER UNSIGNED` underflow → terminal halt | `services/index.ts:964-985` vs `:526-581` |
| **D11** | MEDIUM | Shielded output index is **assumed** `len(outputs)+i`, with no cross-check that an input's wire `mode` matches the DB row's `mode`. If hathor-core numbers shielded outputs in their own space, spending shielded output 0 marks the **transparent** output 0 spent (DB-level double-spend of a real UTXO) while the shielded row stays unspent — silently, no error. The guard is cheap and worth adding regardless of which convention core uses | `services/index.ts:450, 480, 596`; `utils/wallet.ts:334-336` |
| **D12** | MEDIUM | **N+1 inside the open write transaction**: 4 round-trips per shielded output (5 when owned) → up to 160 per vertex at 32 outputs, each holding `tx_output` + `address` row locks; plus 2 per shielded input. `findShieldedAddressOwnershipBatch` **exists** (single query, dedupes by address) and is called only from `voidTx`. Hoisting it plus multi-row `VALUES ?` inserts takes 160 → ~4 | `services/index.ts:492-581`; `utils/wallet.ts:334-344`; `db/index.ts:427-450` |
| **D13** | LOW | `markTxOutputRecovered` returns `affectedRows` *specifically* so callers can detect the idempotent case; the ingest loop discards it and pushes the balance credit unconditionally. Shielded ingest is therefore idempotent **by accident of the outer tx-exists guard**, not by construction — anyone reusing this loop for the D2 sweep double-credits | `services/index.ts:545-554, 565-574`; `db/index.ts:496-513` |
| **D14** | LOW | Two divergent copies of the promote/fail helpers (daemon `= 'unowned'` vs wallet-service `<> 'recovered'`). Whoever builds the sweep must use the `<>` form; reusing the daemon helper makes the sweep appear to run and recover nothing | `daemon/src/db/index.ts:500-538` vs `wallet-service/src/db/shielded.ts:85-116` |
| **D15** | LOW | Shielded `decoded.address` is uncapped in Zod but lands in `VARCHAR(34)`. If a shielded output ever carries the 71-byte long-form CT address (~97 base58 chars) rather than the P2PKH short form, the first insert throws inside the ingest transaction | `types/event.ts:125-132`; `20210706163010-create-address.js:5-9` |

### No-provider runtime behaviour, precisely

Per shielded output, inside the ingest transaction: `insertTxOutput` with `value: null`,
`recovery_state: 'unowned'` → `insertShieldedTxOutputData` → `upsertShieldedAddressObservation`
→ `findShieldedAddressOwnership`. If the address is **unowned** (the common case today) the loop
ends silently — no alert, no log. If **owned**, the rewind throws, the row becomes
`recovery_failed`, and an alert is queued. Nothing is credited, but `address.transactions` **is**
bumped, so the wallet sees "a transaction happened" with a zero balance.

The data needed for a later rewind is all durable — `shielded_tx_output_data` keeps
`commitment`, `range_proof`, `ephemeral_pubkey`, `asset_commitment`; `tx_output.token_id` is
already resolved for mode 1 at observe time; `address.scan_privkey` persists. So recovery
without a resync is possible **in principle** — and impossible **in practice** until D2 is fixed.

### What is solid here

- **Balance algebra.** `fromShielded` sign handling, locked/unlocked routing, and
  `totalShieldedReceived` as a receive-only lifetime accumulator; `Balance.merge`/`clone` carry
  all three shielded fields.
- **Strict-mode insert dance.** Clamping shielded columns to 0 on the INSERT branch and applying
  the signed delta via `ON DUPLICATE KEY UPDATE` bind args — correct and deliberate on both the
  address and wallet writers.
- **Void column coverage.** All three shielded columns subtracted, and the zero-row `DELETE`
  cleanups guard on them so a shielded-only row isn't dropped.
- **Involvement counter symmetry.** One canonical writer and its exact mirror, fed the same
  wire-level address set — the part most likely to have drifted, and it did not.
- **NULL-`value` tolerance throughout.** Every row mapper uses `parseNullableBigInt`;
  `markUtxosAsVoided`/`unspendUtxos` are PK-only; the void candidate filter and `unlockUtxos`
  skip non-`recovered` shielded rows for balance while still flipping the lock flag.
- **Satellite lifecycle.** FK `ON DELETE CASCADE` means `cleanupVoidedTx` needs no second delete.
- **`validateAddressBalances`** is keyed by `(address, token_id)` rather than positionally
  zipped, and asserts the shielded sum as bigint — the positional-zip bug a shielded-only token
  would have triggered is already fixed.
- **Replay safety.** `handleVertexAccepted` returns early when the `transaction` row exists,
  *before* `beginTransaction`, so a re-delivered vertex never reaches the shielded loop. Rollback
  destroys the connection if the rollback itself fails, so a `BEGIN` never leaks back to the pool.
- **Index widening** `tx_output.index` → `SMALLINT UNSIGNED` (255 transparent + 32 shielded).
---

## 5. Eventing, observability and rollout control

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **E1** | BLOCKER | **A shielded receive fires no websocket frame and no push at all.** `getUnifiedBalanceMap` seeds only from transparent I/O, *successful* rewinds and nano headers — a `recovery_failed` address gets no map entry, so `seenWallets` is empty and `sendRealtimeTx` is skipped. Also no `address_tx_history` row | `daemon/src/utils/wallet.ts:297-357`; `daemon/src/services/index.ts:629,649,731-736,742-750` |
| **E2** | BLOCKER | **The void/reorg path emits no realtime or push event whatsoever** — shielded *or* transparent. A client with an open socket is never told a tx was voided; it must re-poll. The RFC asserts the opposite | `daemon/src/services/index.ts:937-1068` (`voidTx`), `:830-898`, `:1070-1173`; sole publisher is `:732`; doc claim `research2/0000-daemon-and-database.md:184` |
| **E3** | HIGH | The `update-tx` channel a void event would use **is deployed with no trigger** — `wsTxNotifyUpdate` has no `events:` block, and nothing publishes an `update-tx` body. Task 8.3 has no pipe to connect to | `wallet-service/serverless.yml:568-575` (contrast `:551-562`); `src/ws/txNotify.ts:98-136` |
| **E4** | HIGH | **No feature flag or kill switch for shielded, anywhere.** Shielded ingest, registration, rewind attempts, alerting and DB writes are unconditionally live on every stage. There is no way to ship dark and enable later, and no way to mute E6 without a code change. The precedent exists and was not followed: `PUSH_NOTIFICATION_ENABLED` | `wallet-service/src/config.ts:20` (only `shieldedMaxAddressGap`); `daemon/src/config.ts:8-28,132-178`; cf. `daemon/src/config.ts:69` + `daemon/src/utils/aws.ts:27-30` |
| **E5** | HIGH | **The live shielded stack gets zero CloudWatch alarms.** `alerts.stages` lists only `mainnet`, `mainnet-stg`, `testnet`, but the shielded network deploys `--stage shielded`, so no alarm resource is ever created there | `wallet-service/serverless.yml:32-36,94-96`; `Makefile` target `deploy-lambdas-testnet-shielded-outputs` |
| **E6** | HIGH | **Alert spam that pages on-call continuously.** One `Severity.MAJOR` per *failed shielded output*, no dedup/aggregation/rate limit, fired by the daemon on every ingest **and** by the wallet-service on every load — and the load runs two sweeps, so twice per output per load, re-driven on every subsequent load. With the provider unwired that is 100% of owned shielded outputs, forever | `daemon/src/services/index.ts:792-800`; `wallet-service/src/shieldedRecovery.ts:93-107`; `api/wallet.ts:828,832`; `db/shielded.ts:137-154` |
| **E7** | HIGH | **No capability advertisement.** `/version` is a fullnode pass-through with no shielded flag, so clients cannot feature-detect — even though `nanoContractsEnabled` sits right there as precedent | `wallet-service/src/api/version.ts:29-43`; `src/nodeConfig.ts:40-60` |
| **E8** | HIGH | **A new shielded-aware client hard-fails against an old service.** `loadBodySchema.validate` runs with Joi defaults (`allowUnknown: false`), so posting `scanXpriv`/`spendXpub` to a pre-shielded deployment returns 400 `invalid-payload`. With E7 there is no way to probe first | `api/wallet.ts:301-312,405-415` |
| **E9** | MEDIUM | `catchup_state` is written `'done'` **regardless of whether anything recovered** — the failure count is only logged. An operator querying it sees uniform success while every balance is wrong | `api/wallet.ts:837-840`, `:858` → `db/shielded.ts:490-499` |
| **E10** | MEDIUM | **Zero shielded observability beyond per-output alerts** — no metric, counter, dashboard, or periodic `recovery_failed` count. `MonitoringActor`, the SyncMachine and `/healthcheck` have no shielded awareness, and the rewind is the one ingest step not wrapped in `withSpan`, so it is invisible in traces | `daemon/src/services/index.ts:526-581` (bare try, cf. `:591,596,626,629`) |
| **E11** | MEDIUM | **NFT gate is over-broad and mis-located.** It skips `processNftEvent` for any vertex with *any* shielded output **or input**, so a transparent NFT creation carrying one unrelated shielded output also loses detection — permanently, with no backfill. The gate lives in the daemon caller, so the other caller (`txProcessor.ts:41`) inherits no protection | `daemon/src/services/index.ts:756-770`; `common/src/utils/nft.utils.ts:190-228` |
| **E12** | MEDIUM | Generic `majorFunctionErrors`/`minorFunctionErrors` alarms **cannot** catch shielded failure even where they deploy: every shielded failure path is caught and swallowed, so Lambda/daemon `Errors` stays flat. The SQS→OpsGenie alert of E6 is the only signal | `wallet-service/src/shieldedRecovery.ts:89-117`; `daemon/src/services/index.ts:576-580` |
| **E13** | MEDIUM | The realtime shielded projection **omits the output index** (`{mode, token_data?, decoded.address}` only), so a client cannot correlate a frame entry to a `tx_output` row — it can only diff `data.addresses`. No doc specifies the projection | `daemon/src/services/index.ts:718-726`; `common/src/types.ts:37-44` |
| **E14** | LOW | Push coerces amounts through `Joi.number()`, so a shielded amount above 2^53−1 silently loses precision (same pre-existing flaw as `total`) | `api/txPushNotificationRequested.ts:52,58,60,136,189` |
| **E15** | LOW | Shielded **spends** never notify — `shieldedAmount` is gross-received, suppressed to 0 on a spend, and the push gate requires `> 0`. Intentional but undocumented | `daemon/src/utils/wallet.ts:755-757`; `api/txPushNotificationRequested.ts:125-137` |
| **E16** | LOW | No shielded-specific i18n key: a confidential receive reuses `new_transaction_received_description_with_tokens` with the shielded amount **summed into** the transparent one, so a mixed tx renders as one indistinguishable number. Strings resolve client-side in hathor-wallet-mobile — an unfiled cross-repo dependency | `api/txPushNotificationRequested.ts:28-40,186-192` |

### What a user sees

**Receiving a shielded output — total silence, then a wrong balance.** The daemon ingests the
output, writes the satellite row, confirms the wallet owns the address, attempts the rewind,
and the rewind throws. The row is marked `recovery_failed`. Because the rewind failed, nothing
enters the unified balance map, so: no websocket frame, no push, no history row. The only
visible trace is `address.transactions` incrementing — a counter the read API surfaces with no
corresponding movement. On the next load, two sweeps re-attempt, fail, fire two MAJOR alerts,
write `catchup_state='done'`, and flip the wallet READY. *Money arrives, the wallet shows
nothing, no notification fires, and the wallet reports itself fully synced.*

**A shielded tx being voided — no notification, ever, for any tx kind.** `voidTx` reverses
balances correctly but publishes nothing (E2). In the shielded case there is a second layer of
nothing: void only reverses rows in `recovery_state='recovered'`, and at runtime no row reaches
that state, so it reverses a zero that was never credited.

**Receiving a shielded NFT — worst of the three.** The NFT gate skips `processNftEvent`
entirely, so `invokeNftHandlerLambda` never fires and explorer-service never creates DAG
metadata — **permanently, with no retry or backfill for that token**. Plus the zero balance and
the silence above. The user sees a custom token with no name, symbol or media, a zero balance,
and no notification.

### What is solid here

- The **additive realtime payload design is right**: keep `{type:'new-tx',data:{…}}`, add
  `shielded_outputs` + `addresses` inside `data`, no values or crypto material on the wire. The
  Joi backward-compat trap (keeping `tx` keyless so new fields aren't rejected) was spotted and
  handled deliberately (`ws/txNotify.ts:34-38`).
- The **push path is genuinely shielded-aware end to end and carefully so** — it is simply
  dormant. `shieldedAmount` is defined as gross-received and documented as never-negative
  because the `[0]`-index gate depends on it; `sortBalanceValueByAbsTotal` sorts on *combined*
  magnitude so a shielded-only receive isn't ranked behind a transparent token and mis-gated
  out (a subtle bug, pre-empted); the Joi field is `.default(0)` so pre-field daemons still
  validate; an empty-balance guard stops a valid-but-empty payload failing the whole batch.
- **Alert placement was correctly fixed**: failures are collected and `addAlert` (an SQS
  round-trip) fires *after* commit, with a comment explaining why — holding `tx_output`/`address`
  row locks across an SQS call would have been a nasty production problem. Severity and volume
  are wrong, but the mechanics are right.
- **Failure paths are rigorously non-throwing**, and `findAndRewindShielded` advances on a
  `(tx_id,index)` keyset cursor rather than set membership, so a re-driven row that fails again
  still terminates the loop. That termination argument is correct and non-obvious.
- **Deferral bookkeeping is unusually honest** — the tracking docs correctly record
  void-realtime, NFT and ct-crypto as not done, with rationale. The aspirational claims all
  live in the older RFCs.

### Design docs that the code contradicts

Four claims a future implementer would wrongly trust:

1. `research2/0000-daemon-and-database.md:184` — promises a void emission. None exists (E2).
2. `research2/00-overview.md` resolved Q4 — "`@hathor/ct-crypto-node` NAPI **stable; pin and
   use directly**". It is not wired at all, and the published versions don't fit (§2).
3. `research2/NOTES.md:161` / `00-overview.md` — WS/push "carry both transparent and shielded
   **deltas**". The WS frame carries no values and no deltas; `0000-…md:803` itself says so.
4. `research2/0000-daemon-and-database.md:813-815` (repeated in the deferred-work doc) — cites
   `daemon/src/crypto/ctRewind.ts` and `daemon/src/services/shielded/recovery.ts`. **Neither
   path exists**; the real location is `packages/common/src/crypto/ctRewind.ts`.

Also undocumented-but-present: the two-sweep settle drain, the unconditional `catchup_state`
write, the `SHIELDED_MAX_ADDRESS_GAP` env var, and the choice of `MAJOR` severity.
---

## 6. Tests, build, migrations and CI

### Test and build health — genuinely good

| Suite | Result |
|---|---|
| `@wallet-service/common` build / `sync-daemon` build / `wallet-service` check-types / `event-downloader` build | all exit 0, clean |
| `@wallet-service/common` tests | **53/53** pass (6 suites) |
| `sync-daemon` tests | **333/333** pass (24 suites) |
| `wallet-service` tests | **481/481** pass (34 suites) |
| **Repo total** | **867/867 tests, 64/64 suites, 0 failures** |
| Migrations up (fresh DB) | all 63 apply, incl. 10 shielded |
| Migrations down (shielded ×10) | all roll back cleanly |

The known `WALLET_MAX_RETRIES` flake did **not** reproduce. Daemon *integration* tests
(event-simulator) were not run — they need `linux/amd64` hathor-core containers and the host is
aarch64 — but none of the three contains a shielded scenario, so no shielded coverage was lost.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **T1** | BLOCKER | **The `tx_output.index` widening (`TINYINT`→`SMALLINT`) is `ALGORITHM=COPY` only** — `index` is part of the PK, so it rewrites the whole clustered index **while rejecting writes**. On a mainnet-scale `tx_output` that is plausibly hours of daemon write-stall. And `make migrate` runs **inline in CodeBuild on every deploy**, including mainnet on any `v*` tag, with no dry-run and no size check | measured: `ERROR 1846: ALGORITHM=INPLACE is not supported… Try ALGORITHM=COPY`; `.codebuild/build.sh` (all 4 mainnet/testnet branches) → `Makefile:50` |
| **T2** | HIGH | **Lint is non-functional repo-wide and CI never runs it** — so shielded code has never been linted. `wallet-service` lint: 96 errors, *all 96* `Parsing error: TS5012` from a doubled path segment in `.eslintrc.yml`; `sync-daemon` lint: no flat config, never runs; root eslint 9 can't read `.eslintrc.yml` | cmds 5–7; `.github/workflows/main.yml` has no lint step |
| **T3** | HIGH | **The deploy pipeline runs no tests and no lint.** CodeBuild is webhook-driven and independent of GH Actions; `buildspec.yml` + `build.sh` contain no test or lint invocation | grep over both files → only incidental `testnet*` var-name matches |
| **T4** | HIGH | **Both crypto mocks ignore the private key** — they resolve on `(commitment, ephemeralPubkey)` and discard `_privateKey`, and every test key is `Buffer.alloc(32, N)`. So *any* key "recovers" any primed output: **a cross-wallet mis-attribution bug — wallet A recovering wallet B's output — would pass every test in the repo.** The most consequential blind spot | `daemon/__tests__/mocks/ct-crypto-node.ts`; `wallet-service/tests/utils/ct-crypto-mock.ts` |
| **T5** | HIGH | **No asset-commitment or surjection-proof verification exists anywhere in our code.** `surjection_proof` is written and echoed to clients (`txOutputs.ts:390`) but never read for verification; `asset_commitment` is only forwarded to the absent provider; the recovered `tokenUid` is **trusted unchecked**. (The deferred-work doc specified a mode-2 asset-commitment cross-check; it was never built) | grep: no verification call sites |
| **T6** | HIGH | Missing provider degrades **silently** — no startup assertion, no healthcheck probe. Neither `HealthCheckActor.ts` nor the wallet-service healthcheck mentions the provider | `requireProvider()` throws lazily per output |
| **T7** | MEDIUM | `20260512100000` does **3 full rebuild passes where 1 suffices**, and builds two `tx_output` indexes that `20260629100000` then drops — pure waste on a huge table. A single 5-clause `ALTER` was measured to produce a byte-identical schema in one pass | probes 15–18 |
| **T8** | MEDIUM | Daemon image is `node:22-alpine` (**musl**), Lambda is `nodejs22.x` (**glibc**), so the NAPI addon needs **two** prebuild flavours. The builder installs no Rust toolchain, so there is no source fallback. `ct-crypto-node@0.4.0` ships glibc prebuilds only | `packages/daemon/Dockerfile` |
| **T9** | MEDIUM | `includeModules` only packages **statically required** externals. Adding the dependency is insufficient — a production file must *statically import* the provider or it never reaches the Lambda artifact | `webpack.config.js` (`nodeExternals`, allowlist = common only) |
| **T10** | MEDIUM | **Zero shielded coverage in the only end-to-end (event-simulator) tests.** All shielded daemon testing uses hand-built fixtures | the 3 `__tests__/integration/*.test.ts` have no shielded scenario |
| **T11** | MEDIUM | `common/index.ts` barrel eagerly instantiates `tiny-secp256k1` WASM for **every** Lambda (`BIP32Factory(ecc)` at module top level), at `memorySize: 256` with WS lambdas on a 2 s timeout / 1500 ms alarm. Import chain confirmed; cold-start cost not measured on Lambda | `common/src/index.ts:12`; `wallet-service/src/config.ts:10` |
| **T12** | MEDIUM | The core `tx_output` migration **cannot be rolled back** once any shielded row exists — the `down()` guards correctly refuse rather than truncate `index > 255` or lose NULL values. Plan the forward fix, not the rollback | measured: `Rollback blocked: tx_output has 1 rows with NULL value or token_id…` |
| **T13** | LOW | Three `address` indexes now lead with `wallet_id` → write amplification (minor; `address` is small) | `SHOW INDEX` |
| **T14** | LOW | wallet-service `test` script lacks `--forceExit` (the CI `jest` script has it) → hangs on open handles locally | observed a suite idle 25 min post-completion |

### Coverage verdict: high on plumbing, zero on cryptography

Line coverage on shielded source is high — `db/shielded.ts` 99.2% stmts, `txOutputs.ts` 97.3%,
`api/wallet.ts` 96.1%, `shieldedRecovery.ts` 94.1%, `common/src/shielded.ts` 100%. But it is
coverage **of plumbing, not of cryptography**.

**Genuinely verified** (real code, real MySQL, mock-independent): void/reorg of shielded rows is
the strongest area — five dedicated tests assert the reversal arithmetic against real DB rows,
so the mock only decides *what* value gets credited, not whether the reversal is right. The
`recovery_failed` state machine is fully covered. Shielded **address derivation is real crypto**,
cross-checked against `derivedAt(n).scanPrivkey`. Schema/DB layer and both migration directions
were executed.

**Mock-shaped** (passes regardless of real behaviour): the rewind itself — `ctRewind.test.ts` is a
pure delegation test (arg order, error wrapping, UID folding) that verifies **zero**
cryptography. Key binding (T4). Commitment soundness — nothing checks the Pedersen commitment
actually opens to the returned value, and the blinding factors are always all-zero buffers.
Mode-2 storage/balance paths are real; mode-2 *crypto* is 100% mock-supplied.

**Untested:** any real provider — and because CI always installs a mock, **CI can structurally
never detect the missing provider.** Note the tests encode the no-provider state as *expected*
("rejects with RewindError when no provider is registered") rather than as a misconfiguration.

### Migration cost, measured

| Operation | Algorithm | Blocking |
|---|---|---|
| `MODIFY index TINYINT→SMALLINT` | **COPY only** | **blocks writes**, full clustered-index rebuild |
| `MODIFY value → NULL` | INPLACE | rebuild, concurrent DML OK |
| `MODIFY token_id → NULL` | INPLACE | rebuild, concurrent DML OK |
| `ADD mode` / `ADD recovery_state` | **INSTANT** | negligible |
| `CREATE INDEX` ×2 | INPLACE | then dropped by `20260629100000` |

`ALGORITHM=INPLACE` is **not available** for the `index` widening, so native online DDL cannot
help — an external copy-and-swap (pt-online-schema-change / gh-ost) is the only non-blocking
route. **Worth checking first whether `index > 255` is reachable at all on your network**: at
255 transparent + 32 shielded the cap is ~287, so if real vertices can't approach it, dropping
the widening removes the only blocking operation and the whole migration becomes INSTANT plus
two INPLACE passes.

### What `testnet-shielded-outputs` (#496) actually turns on

That CodeBuild project existed but every webhook build failed on `Invalid option`, so the
network has run hand-deployed Lambdas since 2026-04-10. #496 makes it live on RCs and releases.
So the next RC will deploy the no-provider code to a real network: shielded ingestion runs, and
the moment a wallet registers CT every shielded output becomes `recovery_failed` + one MAJOR
alert each, balances pinned at 0, with **no kill switch** (E4) and **no alarms on that stage**
(E5). `make migrate` also now runs against that network's DB on every such deploy — including
the COPY rebuild (T1).

Stage env vars for `shielded` are **not in this repo** — `buildspec.yml` has blocks only for
`dev_`/`mainnet_staging_`/`testnetindia_`/`mainnet_`, and 30 `${env:…}` vars in `serverless.yml`
have no default (`ACCOUNT_ID`, `AUTH_SECRET`, `DB_*`, `REDIS_*`, `ALERT_MANAGER_*`, …). Any one
unset fails the deploy. Not verifiable from the repo — **confirm in that AWS account before the
next RC.**
---

## 7. Verdict

**Not production ready, and not close in calendar terms — but the remaining work is
well-understood and mostly small.** The shape of the problem is unusual and worth stating
plainly: the *engineering* is good. The DB schema, balance algebra, void symmetry, registration
proof chain, load lifecycle, API response shaping and test discipline are all production-grade,
and 867/867 tests pass. What is missing is the **cryptographic core** — the feature is a complete
machine with an empty socket where the crypto goes — plus a cluster of operational controls
(flag, alarms, alert volume, migration safety) that were never built because the feature was
never run for real.

Four independent blockers, none of which subsumes the others:

1. **No crypto provider is registered** (§2). Blocked on upstream packaging.
2. **HTR amount-shielded rewind passes a 1-byte token uid** (D1). Fixable today; survives fixing #1.
3. **`recovery_failed` is terminal** (D2 + W2) — no sweep exists, and the daemon's promote helper
   provably cannot promote such a row. So fixing #1 and #2 retroactively fixes **nothing** for
   any wallet that registered earlier.
4. **The enabling migration contains a write-blocking `ALGORITHM=COPY` rebuild of `tx_output`
   wired into every deploy, including mainnet** (T1).

And the thing that makes all of it risky rather than merely incomplete: **there is no feature
flag** (E4), so this cannot be shipped dark; **no alarms exist on the stage that now
auto-deploys it** (E5); and **CI can structurally never detect the missing provider**, because
the test mocks always supply one (T4).

### Risk if shipped as-is

A user receives confidential funds and the wallet shows nothing, notifies nothing, and reports
itself fully synced (E1) — a silent-loss presentation, the worst possible failure mode for a
payments system. Meanwhile on-call is paged once per failed output, twice per wallet load, with
no dedup (E6/D3) and no way to mute it without a code change.

---

## 8. Roadmap

Ordered by dependency, not by severity. Phase 0 is independent of upstream and makes the
current state *safe*; everything after that is sequenced by what unblocks what.

### Phase 0 — Make master safe to carry (no external dependency, start now)

The point of this phase is that `testnet-shielded-outputs` now auto-deploys on every RC.

| Item | Ref |
|---|---|
| **Add `SHIELDED_ENABLED`**, modelled on `PUSH_NOTIFICATION_ENABLED`, gating shielded ingest, CT registration acceptance, and the rewind/alert path in both packages | E4 |
| **Extract the `tx_output` migration from the deploy path.** First check whether `index > 255` is reachable on your network; if not, drop the widening and the migration becomes INSTANT + two INPLACE. If it is needed, collapse the three rebuild passes into one ALTER, delete the two indexes that a later migration drops anyway, and run it via gh-ost/pt-osc as planned maintenance | T1, T7, T12 |
| **Add `shielded` to `custom.alerts.stages`** | E5 |
| **Aggregate and downgrade the recovery alert** — one MINOR per *sweep* with a count, not one MAJOR per output; add an early "provider not registered → one INFO, skip" so the expected state is distinguishable from a real crypto failure (this also removes the per-vertex SQS sync stall) | E6, D3 |
| **Refuse shielded inputs in `txProposalCreate`** with an explicit 400 — spend support is deferred, so accepting and locking them with a wrong derivation path is pure downside | W4 |
| **Fix the lint config** (doubled path segment; daemon flat-config) **and add a lint step to CI**; add a test step to the deploy pipeline or document that branch protection covers it | T2, T3 |
| **Confirm the `shielded` stage's 30 undefaulted env vars exist in that AWS account** before the next RC | §6 |

### Phase 1 — Make the crypto real

| Item | Ref |
|---|---|
| **Upstream (critical path, external):** publish `@hathor/ct-crypto-node` = `0.4.0`'s prebuilds + `0.0.1-shielded`'s `provider.js`, `"./provider"` export and provider dependency. Needs **both glibc** (Lambda) **and musl** (alpine daemon) prebuilds | §2.1, T8 |
| **Fix the HTR token-uid denormalization** — add `denormalizeShieldedTokenId` beside `normalizeShieldedTokenId` so the pair is testable together, plus an assert that `tokenUid.length === 32`. **Do this now; it does not wait on upstream** | D1 |
| Register the provider at daemon startup and via a **static** import in the wallet-service (a dynamic require never reaches the Lambda artifact) | T9 |
| **Startup assertion + healthcheck probe** so a missing provider fails loudly instead of per-output | T6 |
| **Tests that the mocks currently cannot give you:** distinct scan keys per wallet asserting cross-wallet isolation; commitment-opens-to-value soundness; the mode-2 asset-commitment cross-check | T4, T5 |

### Phase 2 — Make recovery durable (gates any real user traffic)

| Item | Ref |
|---|---|
| **Catch-up sweep** for `recovery_state <> 'recovered'`, keyset-cursored, triggerable outside the load lifecycle. **Use the `<> 'recovered'` guard** — reusing the daemon's `= 'unowned'` helper yields a sweep that appears to run and recovers nothing. Collapse the two divergent helper copies | D2, D14, W2 |
| **Fix the unconditional balance credit** (`markTxOutputRecovered`'s `affectedRows` is discarded) *before* reusing the ingest loop in the sweep, or the sweep double-credits | D13 |
| **CTSpend gap extension in the daemon** — project `spend_xpub`/`scan_xpriv`/`shielded_max_gap`/`last_used_shielded_index` into the wallet type, mirror the legacy block, and write rows with `bip32_account = CTSpend` **and** `scan_privkey` (a CTSpend row without the scan key extends the window without extending recovery) | D6, W3 |
| Stop writing `catchup_state = 'done'` when rewinds failed | E9 |

### Phase 3 — Robustness before real traffic

| Item | Ref |
|---|---|
| **Void-ordering crash-loop**: source the shielded spend reversal from what ingest wrote (or drop the `voided = FALSE` gate for that lookup) | D4 |
| **Void recomputation drift**: void from the ingested set, not from current `recovery_state` | D10 |
| **Verify the header schema against hathor-core's event serializer** — if non-nano headers reach `headers[]`, this is a crash-loop and a hard block on shielded mint/melt. ~30 min; could promote to BLOCKER | D7 |
| **Index-space guard**: assert the input's wire `mode` matches the DB row's `mode` — cheap, and the failure mode is a silent DB-level double-spend of a real transparent UTXO | D11 |
| `ct_status = 'error'` should not stop a wallet's **transparent** balance updates | D5 |
| **Zod size caps** from wallet-lib's published constants, plus a **quarantine path** (log + alert + skip the vertex) so a malformed payload cannot permanently halt sync. Caps alone don't buy availability | D9, D15 |

### Phase 4 — User-visible completeness

| Item | Ref |
|---|---|
| **Decide and implement the owned-but-unrecovered notification semantics.** Today it is total silence, which is the worst option; seeding the shielded address into the balance map on a failed-but-owned recovery is a small change | E1 |
| **Void realtime emission** — and wire the `update-tx` Lambda's missing trigger, which the event has no pipe without | E2, E3 |
| **Capability advertisement on `/version`** next to `nanoContractsEnabled`, and make the load schema tolerate-and-report unknown shielded fields so rollout ordering isn't a coin flip | E7, E8 |
| `/wallet/transactions/{txId}` must include `shielded_balance_delta` | W6 |
| **Decide the legacy-client default**: today `/wallet/balances` merges shielded into `unlocked` and an old client shows a balance it cannot spend | W5 |
| Surface pending/failed shielded recovery counts on `/wallet/status` and `?split=true` | W7 |
| **Narrow the NFT gate** to the shielded outputs themselves (it currently kills detection for a transparent NFT that merely shares a tx with a shielded output, permanently and with no backfill) | E11 |
| **File the cross-repo i18n dependency** on hathor-wallet-mobile for a shielded push string | E16 |
| **Document the API contract** — `api-docs.json` has zero shielded mentions today | W8 |

### Phase 5 — Performance and cleanup

| Item | Ref |
|---|---|
| **Batch the ingest N+1**: hoist `findShieldedAddressOwnershipBatch` (it exists, used only by the void path) and use multi-row inserts → ~160 round-trips per vertex down to ~4, and far shorter row-lock holds | D12 |
| Make the `common` barrel's `tiny-secp256k1` WASM init lazy — every Lambda pays it today | T11 |
| Create `token` rows / bump `token.transactions` for shielded-only token movements (blank symbols in push today) | D8 |
| Add a shielded scenario to the event-simulator integration tests | T10 |
| Delete the dead unguarded `tx_output` readers and dead `reconstructWallet` | W9, W10 |
| **Correct the four false RFC claims** (void emission, "ct-crypto stable, pin and use directly", WS/push "carry deltas", and the two non-existent `daemon/src/crypto/…` paths) | §5 |

### Separate track, still fully deferred

**Spending shielded funds is not implemented at all** — no shielded transaction construction, no
proof generation, no account-2 spend proposal. Phases 0–5 deliver a wallet that can *receive and
see* confidential funds. Spending is a distinct project on top.

### Shortest path to a credible testnet pilot

Phase 0 + D1 + Phase 2's sweep + the upstream package. Everything else can follow, but those
four are what separate "demonstrably works for a real user" from "silently loses money".
