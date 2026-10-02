# Shielded Outputs Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-merged shielded-outputs feature safe to carry on `master` while the
cryptographic core is still missing — stop the per-output alert flood, give the live shielded
stage CloudWatch alarms, stop `/tx/proposal` accepting unspendable shielded inputs, and get lint
running in CI so shielded code is linted at all.

**Architecture:** Four independent changes, one per concern, as a stacked chain of branches off
`master`. Nothing here adds a feature flag (explicitly rejected — shielded is supported as soon
as it is live) and nothing here touches the `tx_output` migration (deferred pending the core
team's decision on the maximum output index). Task 2 is the behavioural core: a single
"is a provider registered?" predicate replaces per-output rewind attempts, so shielded rows land
and stay `unowned` instead of being poisoned into `recovery_failed`.

**Tech Stack:** TypeScript, Node 22, yarn 4 workspaces, Jest, MySQL 8 + sequelize-cli
migrations, Serverless Framework v3 (`serverless-plugin-aws-alerts`), ESLint 9 flat config,
GitHub Actions.

**Spec:** `docs/2026-10-01-shielded-outputs-production-readiness-audit.md` §8 "Phase 0", with
the two scope changes the owner decided on 2026-10-02 (no feature flag; migration deferred).

## Global Constraints

- **No feature flag.** Do not add `SHIELDED_ENABLED` or any shielded on/off config. Shielded
  support is unconditional once deployed.
- **Do not touch `db/migrations/20260512100000-alter-tx-output-add-shielded-mode-cols.js`** or
  any other migration. The `index` widening is under discussion with the core team.
- **Node/yarn come from `mise`.** Run commands as `mise exec -- yarn …` from a controller shell.
- Work in the worktree `/media/nas1/projects/hathor/wallet-service/shielded-phase0`
  (dependencies already installed). Never run `yarn install` in the main checkout.
- **Sign every commit** with `git commit -S`. Commit messages end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Branches are a stacked chain off `master`, in task order. Branch names embed the phase number:
  `chore/shielded-phase0-1-alarm-stages`, `fix/shielded-phase0-2-no-provider-shortcircuit`,
  `fix/shielded-phase0-3-reject-shielded-proposal-inputs`, `chore/shielded-phase0-4-lint-ci`.
- `@wallet-service/common` is re-exported through the barrel `packages/common/index.ts`; anything
  added to `src/crypto/ctRewind.ts` is automatically importable as
  `from '@wallet-service/common'`.
- Comments must not reference task or phase numbers. Describe current behaviour only.
- Do not run the full wallet-service suite in one process on aarch64 — 34 suites in one
  `--runInBand` run exhausts V8's WASM allocation. Run targeted suites.

## Review Focus

1. **A provider registered after the first skip.** The one-shot alert must not permanently
   suppress genuine rewind failures once a provider exists — the predicate is read per vertex,
   never cached into a "shielded is broken" latch. Pinned in Task 2.
2. **The no-provider path must not write `recovery_failed`.** That state is unreachable for the
   daemon's promote helper (guarded `= 'unowned'`), so poisoning rows there would make them
   permanently unrecoverable. Rows must stay `unowned`. Pinned in Task 2.
3. **A shielded input mixed with transparent inputs in one proposal.** The whole proposal must be
   rejected before any UTXO is locked, not partially accepted. Pinned in Task 3.
4. **A `tx_output` row whose `mode` column is absent from the mapped object.** `DbTxOutput.mode`
   is optional, so the new guard must treat `undefined` as transparent rather than throwing.
   Pinned in Task 3.
5. **A new deploy stage added to the Makefile but not to `alerts.stages`.** This is exactly how
   the shielded stage ended up with no alarms; the regression test must fail for the next one.
   Pinned in Task 1.

---

### Task 1: Alarms on every deployed stage

The `testnet-shielded-outputs` target deploys `--stage shielded`, but `custom.alerts.stages`
lists only `mainnet`, `mainnet-stg`, `testnet`, so `serverless-plugin-aws-alerts` creates no
alarm resources there. Rather than only adding the missing entry, add a test that derives the
expected stage list from the Makefile so the next new stage cannot silently miss alarms.

**Files:**
- Modify: `packages/wallet-service/serverless.yml:32-36` (the `custom.alerts.stages` list)
- Test: `packages/wallet-service/tests/serverlessAlerts.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Write the failing test**

Create `packages/wallet-service/tests/serverlessAlerts.test.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVERLESS_YML = path.join(REPO_ROOT, 'packages/wallet-service/serverless.yml');
const MAKEFILE = path.join(REPO_ROOT, 'Makefile');

/**
 * `serverless.yml` uses Serverless variable syntax (`${self:...}`, `${env:...}`) which is
 * valid YAML scalar text, so a plain parse is enough to read the `custom.alerts.stages` list.
 */
const readAlertStages = (): string[] => {
  const doc = yaml.load(fs.readFileSync(SERVERLESS_YML, 'utf8')) as {
    custom: { alerts: { stages: string[] } };
  };
  return doc.custom.alerts.stages;
};

/**
 * Every `--stage <name>` the Makefile deploys. `invoke-local` is excluded: it runs a function
 * locally and creates no CloudWatch resources, so it needs no alarms.
 */
const readDeployedStages = (): string[] => {
  const makefile = fs.readFileSync(MAKEFILE, 'utf8');
  const stages = new Set<string>();
  for (const line of makefile.split('\n')) {
    if (!line.includes('serverless deploy')) continue;
    const match = line.match(/--stage\s+(\S+)/);
    if (match) stages.add(match[1]);
  }
  return [...stages];
};

describe('serverless alert stages', () => {
  it('declares alarms for every stage the Makefile deploys', () => {
    const alertStages = readAlertStages();
    const missing = readDeployedStages().filter((stage) => !alertStages.includes(stage));

    expect(missing).toStrictEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace wallet-service jest tests/serverlessAlerts.test.ts`

Expected: FAIL. The assertion reports the stages with no alarms, which on `master` are
`ekvi-main`, `dev-testnet`, `india` and `shielded`.

- [ ] **Step 3: Add the missing stages**

The test reveals four stages with no alarms, not just the shielded one. Add all four, so the
test passes for the right reason. In `packages/wallet-service/serverless.yml`, replace:

```yaml
  alerts:
    stages: # Select which stages to deploy alarms to
      - mainnet
      - mainnet-stg
      - testnet
```

with:

```yaml
  alerts:
    stages: # Select which stages to deploy alarms to
      - mainnet
      - mainnet-stg
      - testnet
      - shielded
      - india
      - dev-testnet
      - ekvi-main
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace wallet-service jest tests/serverlessAlerts.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Verify the rendered config is still valid**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- node -e "const y=require('js-yaml'),f=require('fs');const d=y.load(f.readFileSync('packages/wallet-service/serverless.yml','utf8'));console.log(d.custom.alerts.stages.join(','));console.log('alarms:',d.custom.alerts.alarms.join(','))"`

Expected: prints the seven stages and `alarms: majorFunctionErrors,minorFunctionErrors`.

- [ ] **Step 6: Commit**

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
git add packages/wallet-service/serverless.yml packages/wallet-service/tests/serverlessAlerts.test.ts
git commit -S -m "$(cat <<'MSG'
fix(alarms): deploy CloudWatch alarms to every stage the Makefile deploys

custom.alerts.stages listed only mainnet, mainnet-stg and testnet, so the
shielded, india, dev-testnet and ekvi-main stages got no alarm resources at
all — majorFunctionErrors and minorFunctionErrors were never created there.

Adds a test that derives the expected list from the Makefile's `--stage`
targets, so a newly added deploy stage fails CI instead of silently shipping
without alarms.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: Short-circuit the rewind when no crypto provider is registered

Today every owned shielded output triggers a rewind attempt that throws
`RewindError('shielded crypto provider not registered')`, which marks the row `recovery_failed`
and emits one `Severity.MAJOR` alert **per output** — from the daemon on every ingest and from
the wallet-service on every load (twice per load, since the load runs two sweeps). Two
consequences this task fixes: the paging flood, and the fact that `recovery_failed` is a state
the daemon's own promote helper cannot leave (it is guarded `= 'unowned'`), so the current
behaviour actively poisons rows against a future catch-up sweep.

After this task: with no provider registered, shielded rows are still inserted and still
observed, but no rewind is attempted, no row is marked `recovery_failed`, and at most one alert
is emitted per process.

**Files:**
- Modify: `packages/common/src/crypto/ctRewind.ts` (add the predicate next to the registration seam)
- Modify: `packages/daemon/src/services/index.ts:525-581` (the per-output rewind block) and `:789-800` (the deferred-alert loop)
- Modify: `packages/wallet-service/src/shieldedRecovery.ts` (`findAndRewindShielded`)
- Test: `packages/common/__tests__/crypto/ctRewind.test.ts` (extend)
- Test: `packages/wallet-service/tests/shieldedRecovery.test.ts` (extend)
- Test: `packages/daemon/__tests__/services/services_with_db.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `isShieldedCryptoProviderRegistered(): boolean`, exported from
  `@wallet-service/common` via the `packages/common/index.ts` barrel. Used by the daemon ingest
  loop and by `findAndRewindShielded`.

- [ ] **Step 1: Create the branch**

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
git checkout -b fix/shielded-phase0-2-no-provider-shortcircuit
```

- [ ] **Step 2: Write the failing test for the predicate**

Append to `packages/common/__tests__/crypto/ctRewind.test.ts`, inside the top-level `describe`
(match the file's existing import list — it already imports `setShieldedCryptoProvider` and
`clearShieldedCryptoProvider`; add `isShieldedCryptoProviderRegistered` to that import):

```typescript
  describe('isShieldedCryptoProviderRegistered', () => {
    it('is false before a provider is registered', () => {
      clearShieldedCryptoProvider();

      expect(isShieldedCryptoProviderRegistered()).toBe(false);
    });

    it('is true once a provider is registered and false again after it is cleared', () => {
      setShieldedCryptoProvider({
        rewindAmountShieldedOutput: jest.fn(),
        rewindFullShieldedOutput: jest.fn(),
      } as never);
      expect(isShieldedCryptoProviderRegistered()).toBe(true);

      clearShieldedCryptoProvider();
      expect(isShieldedCryptoProviderRegistered()).toBe(false);
    });
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace @wallet-service/common jest __tests__/crypto/ctRewind.test.ts -t isShieldedCryptoProviderRegistered`
Expected: FAIL — `isShieldedCryptoProviderRegistered is not a function` / TS compile error.

- [ ] **Step 4: Implement the predicate**

In `packages/common/src/crypto/ctRewind.ts`, immediately after `clearShieldedCryptoProvider`:

```typescript
/**
 * Whether a provider is available for the rewind entry points.
 *
 * Callers use this to skip work that can only fail: with no provider, an
 * attempted rewind throws `RewindError` and the output would be recorded as
 * `recovery_failed` — a state the daemon's promote helper cannot leave — so
 * ingestion and catch-up both leave such outputs `unowned` instead.
 *
 * Read this per unit of work rather than caching it: a provider can be
 * registered at any point, and a cached `false` would suppress real failures
 * once one exists.
 */
export function isShieldedCryptoProviderRegistered(): boolean {
  return provider !== null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace @wallet-service/common jest __tests__/crypto/ctRewind.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit the predicate**

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
git add packages/common/src/crypto/ctRewind.ts packages/common/__tests__/crypto/ctRewind.test.ts
git commit -S -m "$(cat <<'MSG'
feat(common): expose whether a shielded crypto provider is registered

Lets ingestion and catch-up skip a rewind that can only throw, instead of
recording the output as recovery_failed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

- [ ] **Step 7: Write the failing test for the wallet-service sweep**

In `packages/wallet-service/tests/shieldedRecovery.test.ts`, add this block. Note the repo's
test mock registers a provider globally via `packages/wallet-service/tests/utils/ct-crypto-mock.ts`,
so the test must clear it and restore it afterwards.

```typescript
describe('findAndRewindShielded with no crypto provider', () => {
  afterEach(() => {
    // Restore the suite-wide mock provider the other tests rely on.
    setupCtCryptoMock();
  });

  it('skips the sweep without marking any output recovery_failed', async () => {
    clearShieldedCryptoProvider();
    const getSpy = jest.spyOn(ShieldedDb, 'getShieldedOutputsToRecover');
    const failSpy = jest.spyOn(ShieldedDb, 'markShieldedTxOutputRecoveryFailed');

    const result = await findAndRewindShielded(mysql, 'my-wallet', logger);

    expect(result).toStrictEqual({ recovered: 0, failed: 0 });
    expect(getSpy).not.toHaveBeenCalled();
    expect(failSpy).not.toHaveBeenCalled();
  });
});
```

Add to that file's imports, matching the style already there:

```typescript
import { clearShieldedCryptoProvider } from '@wallet-service/common';
import * as ShieldedDb from '@src/db/shielded';
import { setupCtCryptoMock } from '@tests/utils/ct-crypto-mock';
```

Check the existing file first: it may already import `setupCtCryptoMock` (or whatever the mock's
exported setup function is named — read `tests/utils/ct-crypto-mock.ts:82` and use the real
name) and already have a `mysql`/`logger` fixture. Reuse them rather than redeclaring.

- [ ] **Step 8: Run it to verify it fails**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace wallet-service jest tests/shieldedRecovery.test.ts -t "no crypto provider"`
Expected: FAIL — `getShieldedOutputsToRecover` *was* called, and the outputs were marked
`recovery_failed`.

- [ ] **Step 9: Implement the sweep short-circuit**

In `packages/wallet-service/src/shieldedRecovery.ts`, add `isShieldedCryptoProviderRegistered`
to the existing `@wallet-service/common` import, then insert at the very top of
`findAndRewindShielded`'s body, before `let recovered = 0;`:

```typescript
  // With no provider every rewind throws, and recording the outputs as
  // recovery_failed would strand them: the daemon's promote helper only
  // advances rows that are still `unowned`. Leave them untouched for a later
  // catch-up and report one alert for the whole sweep instead of one per output.
  if (!isShieldedCryptoProviderRegistered()) {
    await reportMissingProvider(walletId, logger);
    return { recovered: 0, failed: 0 };
  }
```

Add this helper above `findAndRewindShielded`:

```typescript
/** Set once a missing-provider alert has been emitted, so a sweep per wallet load does not page repeatedly. */
let missingProviderAlerted = false;

/**
 * Report an absent shielded crypto provider once per process. The condition is
 * environmental rather than per-output, so one alert carries all the
 * information an operator needs; `addAlert` swallows its own errors.
 */
const reportMissingProvider = async (walletId: string, logger: Logger): Promise<void> => {
  logger.warn('Shielded catch-up skipped: no shielded crypto provider is registered', { walletId });
  if (missingProviderAlerted) return;
  missingProviderAlerted = true;
  await addAlert(
    'Shielded crypto provider not registered',
    'Shielded outputs cannot be recovered: no shielded crypto provider is registered. '
    + 'Owned shielded outputs stay unowned and balances exclude them until one is installed.',
    Severity.MAJOR,
    { wallet_id: walletId, source: 'wallet-service' },
    logger,
  );
};
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace wallet-service jest tests/shieldedRecovery.test.ts`
Expected: PASS, every test in the file (the pre-existing ones still exercise the mocked provider).

- [ ] **Step 11: Write the failing test for the daemon ingest loop**

In `packages/daemon/__tests__/services/services_with_db.test.ts`, add a test alongside the
existing shielded ingest tests. Read how the neighbouring shielded tests build their vertex and
assert on `tx_output` (they use the `vertex-with-shielded` style fixtures plus
`primeAmountRewind`/`resetCtCryptoMock` from `../mocks/ct-crypto-node`) and follow that shape.
The new test clears the provider instead of priming it:

```typescript
  it('leaves owned shielded outputs unowned when no crypto provider is registered', async () => {
    clearShieldedCryptoProvider();
    // An address claimed by a wallet: the ingest would normally attempt a rewind here.
    await addToAddressTable(mysql, [{
      address: SHIELDED_ADDRESS,
      index: 0,
      walletId: 'my-wallet',
      transactions: 0,
    }]);
    await claimShieldedAddress(mysql, SHIELDED_ADDRESS, 'my-wallet');

    await handleVertexAccepted(buildShieldedVertexContext(), ignoredEvent);

    const rows = await mysql.query(
      'SELECT `recovery_state`, `value` FROM `tx_output` WHERE `tx_id` = ? AND `mode` <> 0',
      [SHIELDED_TX_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].recovery_state).toStrictEqual('unowned');
    expect(rows[0].value).toBeNull();
  });
```

Use the file's own existing fixture helpers and constants for `SHIELDED_ADDRESS`,
`SHIELDED_TX_ID`, `buildShieldedVertexContext()` and the address-claiming helper — do not invent
new ones. Add `clearShieldedCryptoProvider` to the imports from `@wallet-service/common`, and
call `resetCtCryptoMock()` in this test's `afterEach` so later tests get the provider back.

- [ ] **Step 12: Run it to verify it fails**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace sync-daemon jest __tests__/services/services_with_db.test.ts -t "no crypto provider is registered"`
Expected: FAIL — `recovery_state` is `'recovery_failed'`, not `'unowned'`.

- [ ] **Step 13: Implement the daemon short-circuit**

In `packages/daemon/src/services/index.ts`, add `isShieldedCryptoProviderRegistered` to the
existing `import { rewindAmount, rewindFully } from '@wallet-service/common';`.

Before the `for (let i = 0; i < shieldedOutputs.length; i++)` loop (just after the
`failedShieldedRecoveries` declaration), add:

```typescript
        // Read once per vertex, not cached across vertices: a provider can be
        // registered at any time, and a stale `false` would hide real failures.
        const canRewind = isShieldedCryptoProviderRegistered();
```

Then change the ownership/rewind block. Replace:

```typescript
          const owned = await findShieldedAddressOwnership(mysql, so.decoded.address);
          if (owned) {
```

with:

```typescript
          // Skip the ownership lookup entirely when no rewind is possible: its
          // only purpose is to decide whether to rewind, and recording the
          // output as recovery_failed would strand it — the promote helper only
          // advances rows that are still `unowned`.
          const owned = canRewind
            ? await findShieldedAddressOwnership(mysql, so.decoded.address)
            : null;
          if (owned) {
```

After the loop closes and before `const involvedAddresses = ...`, add:

```typescript
        if (!canRewind && shieldedOutputs.length > 0) {
          logger.warn('Shielded outputs ingested without a rewind: no shielded crypto provider is registered', {
            txId: hash,
            shieldedOutputs: shieldedOutputs.length,
          });
          missingProviderAlertPending = !missingProviderAlerted;
        }
```

Declare the one-shot state at module scope, next to the other module-level declarations:

```typescript
/** Set once a missing-provider alert has been emitted, so ingestion does not page per vertex. */
let missingProviderAlerted = false;
```

and declare `let missingProviderAlertPending = false;` alongside `failedShieldedRecoveries`
inside the handler. Then in the post-commit alert section (after the
`for (const failure of failedShieldedRecoveries)` loop), add:

```typescript
        if (missingProviderAlertPending) {
          missingProviderAlerted = true;
          await addAlert(
            'Shielded crypto provider not registered',
            'Shielded outputs are being ingested but cannot be recovered: no shielded crypto '
            + 'provider is registered. Owned outputs stay unowned and balances exclude them.',
            Severity.MAJOR,
            { tx_id: hash, shielded_outputs: shieldedOutputs.length, source: 'daemon' },
            logger,
          );
        }
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace sync-daemon jest __tests__/services/services_with_db.test.ts`
Expected: PASS, every test in the file. The pre-existing shielded recovery tests prime the mock
provider, so `canRewind` is true for them and their behaviour is unchanged.

- [ ] **Step 15: Pin that the predicate is not cached across vertices**

Review Focus item 1 — once a provider is registered, the next vertex must rewind normally. The
one-shot alert flag must not latch the daemon into a "shielded is broken" state. Add to
`packages/daemon/__tests__/services/services_with_db.test.ts`, directly after the previous test,
reusing the same fixtures:

```typescript
  it('recovers a later vertex once a provider is registered', async () => {
    clearShieldedCryptoProvider();
    await claimShieldedAddress(mysql, SHIELDED_ADDRESS, 'my-wallet');
    await handleVertexAccepted(buildShieldedVertexContext(), ignoredEvent);

    // A provider becomes available; the next vertex must rewind, not inherit the skip.
    resetCtCryptoMock();
    primeAmountRewind({ value: 500n });
    await handleVertexAccepted(buildShieldedVertexContext(SECOND_SHIELDED_TX_ID), ignoredEvent);

    const rows = await mysql.query(
      'SELECT `recovery_state`, `value` FROM `tx_output` WHERE `tx_id` = ? AND `mode` <> 0',
      [SECOND_SHIELDED_TX_ID],
    );
    expect(rows[0].recovery_state).toStrictEqual('recovered');
    expect(rows[0].value).toStrictEqual('500');
  });
```

Match the fixture helpers' real signatures: if `buildShieldedVertexContext()` does not take a
tx-id argument, add a second fixture or parameterise it, and read back `value` in whatever form
the suite's other assertions use (the driver returns BIGINT as a string under
`bigNumberStrings`). Confirm the primed value matches what `primeAmountRewind` expects.

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace sync-daemon jest __tests__/services/services_with_db.test.ts -t "once a provider is registered"`
Expected: PASS.

- [ ] **Step 16: Run the full daemon and common suites**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace @wallet-service/common run test && mise exec -- yarn workspace sync-daemon run test`
Expected: 53/53 and 333/333 plus the new tests, 0 failures. This is a shared-shape change to a
`common` export, so the whole suite matters, not just the targeted tests.

- [ ] **Step 17: Commit**

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
git add packages/daemon/src/services/index.ts packages/daemon/__tests__/services/services_with_db.test.ts \
        packages/wallet-service/src/shieldedRecovery.ts packages/wallet-service/tests/shieldedRecovery.test.ts
git commit -S -m "$(cat <<'MSG'
fix(shielded-outputs): skip the rewind when no crypto provider is registered

With no provider, every rewind threw and the output was recorded as
recovery_failed — one MAJOR alert per output, from the daemon on every ingest
and from the wallet-service on every load (twice, since a load sweeps twice).

recovery_failed is also a dead end: the daemon's promote helper only advances
rows that are still `unowned`, so the old behaviour stranded exactly the rows a
later catch-up needs to pick up. Ingestion now leaves them `unowned`, skips the
ownership lookup that only existed to decide whether to rewind, and reports the
missing provider once per process instead of once per output.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: Reject shielded inputs in `POST /tx/proposal`

`getUtxos` admits a shielded row whose `recovery_state = 'recovered'`
(`db/index.ts:1037`: `AND (mode = ? OR recovery_state = ?)`), so such a UTXO passes
`checkMissingUtxos` and `validateUtxoAddresses` — its CTSpend address genuinely belongs to the
wallet — and then gets locked under the proposal by `markUtxosWithProposalId`. The returned
derivation path is hard-coded to the legacy account (`txProposalCreate.ts:157`), so the client is
told to sign an account-2 address with an account-0 path and the proposal can never be completed;
the UTXO stays locked until the cleanup cron. Shielded spending is a separate, unstarted project,
so the endpoint should refuse these inputs outright.

**Files:**
- Modify: `packages/wallet-service/src/api/errors.ts` (add the error code)
- Modify: `packages/wallet-service/src/api/utils.ts:25-59` (add it to `STATUS_CODE_TABLE`)
- Modify: `packages/wallet-service/src/api/txProposalCreate.ts:108-115` (add the guard)
- Test: `packages/wallet-service/tests/txProposal.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `ApiError.INPUTS_SHIELDED_UNSUPPORTED = 'inputs-shielded-unsupported'`, HTTP 400.

- [ ] **Step 1: Create the branch**

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
git checkout -b fix/shielded-phase0-3-reject-shielded-proposal-inputs
```

- [ ] **Step 2: Write the failing test**

Append to `packages/wallet-service/tests/txProposal.test.ts`. This matches the idiom of the
existing create tests in that file (`addToWalletTable` with the literal `'xpubkey'`/`'auth_xpubkey'`
placeholders, a `hathorLib.Transaction` built from `hathorLib.Input`/`hathorLib.Output`, and
`makeGatewayEventWithAuthorizer`). `addToUtxoTable` already accepts `mode` and `recoveryState`
(`tests/utils.ts:604-605`), so the shielded row can be seeded directly.

`getUtxos` is already imported from `@src/db` in that file. Add this to the existing imports:

```typescript
import { ShieldedOutputMode, RecoveryState } from '@wallet-service/common';
```

```typescript
test('POST /txproposals rejects a recovered shielded utxo with ApiError.INPUTS_SHIELDED_UNSUPPORTED', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);
  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 1,
    bip32_account: 2,
  }]);

  // A shielded output whose value has been revealed. It passes every ownership
  // and availability check, which is exactly why it needs an explicit refusal.
  const utxos = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: '00',
    address: ADDRESSES[0],
    value: 300n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
    mode: ShieldedOutputMode.AmountShielded,
    recoveryState: RecoveryState.Recovered,
  }];
  await addToUtxoTable(mysql, utxos);

  const script = new hathorLib.P2PKH(new hathorLib.Address(ADDRESSES[0], {
    network: new hathorLib.Network(process.env.NETWORK),
  })).createScript();
  const transaction = new hathorLib.Transaction(
    [new hathorLib.Input(utxos[0].txId, utxos[0].index)],
    [new hathorLib.Output(300n, script, { tokenData: 0 })],
  );

  const event = makeGatewayEventWithAuthorizer('my-wallet', null, JSON.stringify({
    txHex: transaction.toHex(),
  }));
  const result = await txProposalCreate(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toBe(400);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toBe(ApiError.INPUTS_SHIELDED_UNSUPPORTED);
  expect(returnBody.shielded).toStrictEqual([{ txId: TX_IDS[0], index: 0 }]);

  // The refusal must happen before anything is locked.
  const stillFree = await getUtxos(mysql, [{ txId: TX_IDS[0], index: 0 }]);
  expect(stillFree[0].txProposalId).toBeFalsy();
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace wallet-service jest tests/txProposal.test.ts -t "rejects a recovered shielded utxo"`
Expected: FAIL with `statusCode` 201 — the proposal is created and the UTXO is locked.

- [ ] **Step 4: Add the error code**

In `packages/wallet-service/src/api/errors.ts`, after the `INPUTS_NOT_IN_WALLET` line:

```typescript
  INPUTS_SHIELDED_UNSUPPORTED = 'inputs-shielded-unsupported',
```

In `packages/wallet-service/src/api/utils.ts`, after the `[ApiError.INPUTS_NOT_IN_WALLET]: 400,`
entry in `STATUS_CODE_TABLE`:

```typescript
  [ApiError.INPUTS_SHIELDED_UNSUPPORTED]: 400,
```

- [ ] **Step 5: Add the guard**

In `packages/wallet-service/src/api/txProposalCreate.ts`, add `isShieldedMode` and
`ShieldedOutputMode` to the `@wallet-service/common` imports, then insert immediately after the
`INPUTS_NOT_FOUND` check (after the `missing.length > 0` block) and before
`validateUtxoAddresses`:

```typescript
  // Spending a shielded output is not supported: the service cannot build the
  // proof, and the derivation path returned below assumes the legacy account.
  // Refuse before any utxo is locked under the proposal.
  const shielded = inputUtxos
    .filter((utxo) => isShieldedMode(utxo.mode ?? ShieldedOutputMode.Transparent))
    .map((utxo) => ({ txId: utxo.txId, index: utxo.index }));

  if (shielded.length > 0) {
    return closeDbAndGetError(mysql, ApiError.INPUTS_SHIELDED_UNSUPPORTED, { shielded });
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace wallet-service jest tests/txProposal.test.ts -t "rejects a recovered shielded utxo"`
Expected: PASS.

- [ ] **Step 7: Add the mixed-inputs test**

Review Focus item 3 — one shielded input among transparent ones must reject the whole proposal.
Append to the same file:

```typescript
test('POST /txproposals rejects the whole proposal when only one input is shielded', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);
  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 2,
    bip32_account: 0,
  }]);

  const utxos = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: '00',
    address: ADDRESSES[0],
    value: 100n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[1],
    index: 0,
    tokenId: '00',
    address: ADDRESSES[0],
    value: 200n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
    mode: ShieldedOutputMode.AmountShielded,
    recoveryState: RecoveryState.Recovered,
  }];
  await addToUtxoTable(mysql, utxos);

  const script = new hathorLib.P2PKH(new hathorLib.Address(ADDRESSES[0], {
    network: new hathorLib.Network(process.env.NETWORK),
  })).createScript();
  const transaction = new hathorLib.Transaction(
    [
      new hathorLib.Input(utxos[0].txId, utxos[0].index),
      new hathorLib.Input(utxos[1].txId, utxos[1].index),
    ],
    [new hathorLib.Output(300n, script, { tokenData: 0 })],
  );

  const event = makeGatewayEventWithAuthorizer('my-wallet', null, JSON.stringify({
    txHex: transaction.toHex(),
  }));
  const result = await txProposalCreate(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toBe(400);
  expect(returnBody.error).toBe(ApiError.INPUTS_SHIELDED_UNSUPPORTED);
  // Only the shielded input is named, but neither may be locked.
  expect(returnBody.shielded).toStrictEqual([{ txId: TX_IDS[1], index: 0 }]);

  const stillFree = await getUtxos(mysql, [
    { txId: TX_IDS[0], index: 0 },
    { txId: TX_IDS[1], index: 0 },
  ]);
  expect(stillFree).toHaveLength(2);
  stillFree.forEach((utxo) => expect(utxo.txProposalId).toBeFalsy());
});
```

- [ ] **Step 8: Run both tests**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace wallet-service jest tests/txProposal.test.ts`
Expected: PASS, every test in the file — the existing transparent create tests must be
unaffected, which also covers Review Focus item 4 (they seed rows with no `mode`, so
`utxo.mode ?? Transparent` must treat `undefined` as transparent).

- [ ] **Step 9: Commit**

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
git add packages/wallet-service/src/api/errors.ts packages/wallet-service/src/api/utils.ts \
        packages/wallet-service/src/api/txProposalCreate.ts packages/wallet-service/tests/txProposal.test.ts
git commit -S -m "$(cat <<'MSG'
fix(tx-proposal): refuse shielded inputs instead of locking them

getUtxos admits a shielded output once its value is revealed, so it passed
every ownership check and was locked under the proposal — but the returned
derivation path assumes the legacy account, so an account-2 address was handed
a path it cannot sign with. The proposal could never be completed and the utxo
stayed locked until the cleanup cron.

Shielded spending is not implemented, so the endpoint now refuses such inputs
with inputs-shielded-unsupported (400) before anything is locked, naming the
offending outputs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: Working lint, and lint in CI

Lint does not run anywhere today. The repo has only a legacy `.eslintrc.yml` while ESLint 9.39.4
resolves in every workspace, and declared versions disagree (root 9.39.4, wallet-service 8.50.0,
daemon 9.3.0). `yarn workspace wallet-service run lint` fails with 96 `TS5012` parse errors
because `.eslintrc.yml` sets `project: './packages/wallet-service/tsconfig.json'` relative to a
cwd that *is* `packages/wallet-service`, doubling the path; `yarn workspace sync-daemon run lint`
fails outright because ESLint 9 wants a flat config. CI has no lint step. Net effect: shielded
code has never been linted.

The configured rule set (`eslint:recommended` + `plugin:@typescript-eslint/recommended`) needs no
type information, so the flat config deliberately omits `parserOptions.project`. That also
removes the 41 "file was not found in any of the provided project(s)" parse errors that type-aware
linting produces for files outside each package's `tsconfig` include (for example
`packages/daemon/__tests__/__fixtures__/events.ts`), leaving 61 real violations to fix.

**Files:**
- Create: `eslint.config.mjs`
- Delete: `.eslintrc.yml`
- Modify: `package.json` (add a root `lint` script; it already owns eslint 9.39.4 and `@typescript-eslint/*` 8.58.2)
- Modify: `packages/wallet-service/package.json:6` and `:66-69`, `packages/daemon/package.json:13` and `:43-46`, `packages/event-downloader/package.json:16` (point `lint` at the root config; drop the stale duplicate eslint/`@typescript-eslint` devDependencies)
- Modify: `.github/workflows/main.yml` (add a lint step)
- Modify: the 61 files/lines the violations point at
- Test: none — lint is itself the check; CI running it is the regression guard

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: a root `yarn lint` that exits 0.

- [ ] **Step 1: Create the branch**

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
git checkout -b chore/shielded-phase0-4-lint-ci
```

- [ ] **Step 2: Confirm lint is broken**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace wallet-service run lint; mise exec -- yarn workspace sync-daemon run lint`
Expected: the first prints 96 `Parsing error: error TS5012 … packages/wallet-service/packages/wallet-service/tsconfig.json`; the second prints
`ESLint couldn't find an eslint.config.(js|mjs|cjs) file.`

- [ ] **Step 3: Write the flat config**

Create `eslint.config.mjs`:

```javascript
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.webpack/**',
      '**/.serverless/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node builtins; the previous config got these from `env: node`.
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      // Carried over from .eslintrc.yml: @ts-ignore is the agreed way to park a
      // suppression until an upstream type is fixed, `any` is still widespread,
      // and unused-vars is handled by the compiler.
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
```

Note: the rule set is intentionally type-unaware — no `parserOptions.project` — because none of
the enabled rules need type information, and requiring a project would fail on every file outside
a package's `tsconfig` include.

- [ ] **Step 4: Add the parser packages and the root script**

`typescript-eslint` (the v8 meta-package) and `@eslint/js` are needed by the config. Run:

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
mise exec -- yarn add -D -W @eslint/js@9.39.4 typescript-eslint@8.58.2
```

Then in the root `package.json` `scripts`, add:

```json
    "lint": "eslint .",
```

- [ ] **Step 5: Point the package scripts at the root config and drop the stale deps**

ESLint 9 walks up to the nearest `eslint.config.mjs`, but these scripts run with the package as
cwd, so point them at the repo root explicitly and let the root own the toolchain.

In `packages/wallet-service/package.json`, replace the `lint` script with:

```json
    "lint": "eslint --config ../../eslint.config.mjs src tests",
```

and delete the `eslint`, `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`
entries from its `devDependencies` (they pin 8.50.0 / 6.7.4 / 3.3.0 and are shadowed by the root
anyway).

In `packages/daemon/package.json`, replace the `lint` script with:

```json
    "lint": "eslint --config ../../eslint.config.mjs src __tests__",
```

and delete its `eslint`, `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`
devDependencies.

In `packages/event-downloader/package.json`, replace the `lint` script with:

```json
    "lint": "eslint --config ../../eslint.config.mjs src",
```

Then delete the old config and refresh the lockfile:

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
git rm .eslintrc.yml
mise exec -- yarn install
git checkout -- .yarnrc.yml 2>/dev/null || true
```

The `git checkout -- .yarnrc.yml` undoes the settings yarn writes into that file on install; it
must not be part of the commit.

Also check the `yarn.lock` diff before staging it. A local yarn newer than the one that wrote
the lockfile rewrites `__metadata.version` (8 → 10) and re-hashes some `resolve@patch:` entries.
That churn is unrelated to adding `@eslint/js` and `typescript-eslint`; if it appears, either
pin the repo's yarn version first or keep only the genuine dependency additions in the diff.

- [ ] **Step 6: Confirm lint now runs and see the real violations**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn lint`
Expected: it runs to completion (no parse errors, no missing-config error) and reports ~61
problems, dominated by `no-useless-escape` (32) and `@typescript-eslint/no-require-imports` (20),
plus `import/first` (3), `@typescript-eslint/no-non-null-asserted-optional-chain` (2),
`jest/valid-expect` (1), `@typescript-eslint/no-empty-object-type` (1), `prefer-const` (1),
`@typescript-eslint/no-unnecessary-type-constraint` (1).

If `import/first` or `jest/valid-expect` are reported as unknown rules, they came from plugins
the old config pulled in transitively and are not configured here; that is expected and those
counts simply disappear.

- [ ] **Step 7: Auto-fix what is mechanical**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn lint --fix`

This resolves `no-useless-escape` and `prefer-const` in place. Then re-run `mise exec -- yarn lint`
and confirm the remaining problems are only the ones needing a judgement call.

- [ ] **Step 8: Fix the remaining violations by hand**

Work through what `yarn lint` still reports. Guidance per rule:

- `@typescript-eslint/no-require-imports` — these are deliberate lazy/CommonJS requires (for
  example the `require()` block in `packages/wallet-service/src/db/index.ts:15-21`). Converting
  them to `import` risks changing module-init order in a Lambda bundle, which is not a Phase 0
  risk worth taking. Disable the rule for those lines with a reason:
  `// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate CommonJS require; converting changes module init order in the bundle`
- `@typescript-eslint/no-non-null-asserted-optional-chain` — a real latent bug shape
  (`a?.b!`). Replace with an explicit guard or `??`, do not suppress.
- `@typescript-eslint/no-unnecessary-type-constraint` at `packages/wallet-service/src/utils.ts:121`
  — delete the redundant `extends unknown`.
- `@typescript-eslint/no-empty-object-type` — replace the `{}` type with `object` or the
  specific shape intended.

Do not turn any rule off globally to clear a violation.

- [ ] **Step 9: Verify lint is clean and nothing else broke**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn lint && mise exec -- yarn workspace wallet-service run check-types && mise exec -- yarn workspace @wallet-service/common run build && mise exec -- yarn workspace sync-daemon run build`
Expected: all exit 0.

- [ ] **Step 10: Run the test suites**

Run: `cd /media/nas1/projects/hathor/wallet-service/shielded-phase0 && mise exec -- yarn workspace @wallet-service/common run test && mise exec -- yarn workspace sync-daemon run test`
Expected: 53/53 and 333/333, 0 failures. The `--fix` pass edited source files, so this confirms
no behaviour changed.

- [ ] **Step 11: Add the lint step to CI**

In `.github/workflows/main.yml`, insert between the "Install dependencies" and "Initialize DB"
steps:

```yaml
    - name: Lint
      run: |
        nix develop . -c yarn lint
```

- [ ] **Step 12: Commit**

```bash
cd /media/nas1/projects/hathor/wallet-service/shielded-phase0
git add -A
git status   # confirm .yarnrc.yml is NOT staged
git commit -S -m "$(cat <<'MSG'
chore(lint): migrate to eslint flat config and run lint in CI

Lint did not run anywhere. The repo carried only a legacy .eslintrc.yml while
eslint 9 resolved in every workspace, and the wallet-service script failed with
96 TS5012 errors because the config's relative `project` path doubled when
eslint ran with the package as cwd. The daemon script failed outright for want
of a flat config. CI had no lint step, so none of this surfaced — and shielded
code had never been linted.

Adds eslint.config.mjs, points every package script at it, drops the duplicate
eslint/@typescript-eslint devDependencies that were shadowed by the root, fixes
the violations this uncovers, and adds a lint step to CI.

The config is deliberately type-unaware: no enabled rule needs type
information, and requiring a project failed on every file outside a package's
tsconfig include.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Deferred out of Phase 0 (tracked, not done here)

- **`tx_output.index` widening / migration in the deploy path** (audit T1, T7, T12). The
  widening is `ALGORITHM=COPY` and runs inline in every CodeBuild deploy. Blocked on the core
  team's decision about the maximum output index: if the concatenated index stays within 255 the
  widening migration can be removed outright, which also removes the only write-blocking
  operation. Revisit once that decision lands, and settle audit finding D11 (the daemon assumes
  shielded indices are `len(outputs)+i` with no guard) in the same discussion.
- **The `shielded` stage's 30 undefaulted `${env:…}` variables** (`ACCOUNT_ID`, `AUTH_SECRET`,
  `DB_*`, `REDIS_*`, `ALERT_MANAGER_*`, …) are not defined in `buildspec.yml`, which has blocks
  only for `dev_`/`mainnet_staging_`/`testnetindia_`/`mainnet_`. Needs AWS account access to
  confirm before the next RC; any one unset fails the deploy.
