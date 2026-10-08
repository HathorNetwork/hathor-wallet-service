/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';
import {
  addAlert,
  Severity,
  clearShieldedCryptoProvider,
  Bip32Account,
} from '@wallet-service/common';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase, addToAddressTable } from '@tests/utils';
import {
  resetCtCryptoMock, primeAmountRewind, primeFullyRewind, primeScanMiss, lastAmountRewindArgs,
} from '@tests/utils/ct-crypto-mock';
import {
  rewindShieldedOutput, findAndRewindShielded, resetMissingProviderAlert, reportShieldedSweeps, SweepOutcome,
} from '@src/shieldedRecovery';
import * as ShieldedDb from '@src/db/shielded';
import { ShieldedOutputToRecover } from '@src/db/shielded';

// addAlert reaches SQS; replace just that export on the common barrel with a mock,
// keeping the real rewind wrapper + provider seam the orchestration also imports.
jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: jest.fn().mockResolvedValue(undefined),
}));
const mockedAddAlert = addAlert as jest.Mock;

const mysql: ServerlessMysql = getDbConnection();
const logger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} } as unknown as Logger;

const insertShieldedOutput = (txId: string, index: number, address: string, mode: number, recoveryState: string) =>
  mysql.query(
    `INSERT INTO \`tx_output\`
       (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
        \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`mode\`, \`recovery_state\`)
     VALUES (?, ?, ?, NULL, NULL, 0, NULL, NULL, FALSE, FALSE, ?, ?)`,
    [txId, index, address, mode, recoveryState],
  );

const readOutput = async (txId: string, index: number) => (await mysql.query(
  'SELECT `value`, `token_id`, `recovery_state` FROM `tx_output` WHERE `tx_id` = ? AND `index` = ?',
  [txId, index],
))[0];

const amountOutput = (overrides: Partial<ShieldedOutputToRecover> = {}): ShieldedOutputToRecover => ({
  txId: 'tx1', index: 0, address: 'a1', mode: 1, tokenId: '00',
  scanPrivkey: Buffer.alloc(32, 1),
  ephemeralPubkey: Buffer.alloc(33, 0xc1),
  commitment: Buffer.alloc(33, 0xa1),
  rangeProof: Buffer.alloc(8, 0xb1),
  assetCommitment: null,
  ...overrides,
});

beforeEach(async () => {
  await cleanDatabase(mysql);
  resetCtCryptoMock();
  resetMissingProviderAlert();
  mockedAddAlert.mockClear();
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('rewindShieldedOutput', () => {
  it('opens an amount-shielded output without promoting it', async () => {
    await insertShieldedOutput('tx1', 0, 'a1', 1, 'unowned');
    const out = amountOutput();
    primeAmountRewind({
      commitment: out.commitment, ephemeralPubkey: out.ephemeralPubkey, value: 1500n, tokenUid: Buffer.alloc(32, 0),
    });

    const outcome = await rewindShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome).toEqual({ txId: 'tx1', index: 0, address: 'a1', recovered: true, missed: false, tokenId: '00', value: 1500n });
    // Promotion is the commit's job, together with the balance rebuilds.
    expect((await readOutput('tx1', 0)).recovery_state).toBe('unowned');
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('hands the provider a 32-byte uid for the canonical native token', async () => {
    await insertShieldedOutput('tx1', 0, 'a1', 1, 'unowned');
    const out = amountOutput();
    primeAmountRewind({
      commitment: out.commitment,
      ephemeralPubkey: out.ephemeralPubkey,
      value: 1500n,
      tokenUid: Buffer.alloc(32, 0),
    });

    await rewindShieldedOutput(mysql, 'w1', out, logger);

    // tx_output.token_id holds the canonical '00'; the asset generator needs 32 bytes.
    const args = lastAmountRewindArgs();
    expect(args).not.toBeNull();
    expect(args!.tokenUid).toHaveLength(32);
    expect(args!.tokenUid.equals(Buffer.alloc(32, 0))).toBe(true);
  });

  it('opens a fully-shielded output, taking the token from the rewind', async () => {
    await insertShieldedOutput('tx2', 0, 'a1', 2, 'unowned');
    const out = amountOutput({
      txId: 'tx2', mode: 2, tokenId: null, assetCommitment: Buffer.alloc(33, 0xd2),
      commitment: Buffer.alloc(33, 0xa2), ephemeralPubkey: Buffer.alloc(33, 0xc2),
    });
    primeFullyRewind({
      commitment: out.commitment, ephemeralPubkey: out.ephemeralPubkey, value: 42n,
      tokenUid: Buffer.from('ab'.repeat(32), 'hex'), assetCommitment: out.assetCommitment!,
    });

    const outcome = await rewindShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome).toMatchObject({ recovered: true, tokenId: 'ab'.repeat(32), value: 42n });
    expect((await readOutput('tx2', 0)).recovery_state).toBe('unowned');
  });

  it('marks recovery_failed and returns the failure when the rewind throws (unprimed)', async () => {
    await insertShieldedOutput('tx3', 0, 'a1', 1, 'unowned');
    const out = amountOutput({ txId: 'tx3' }); // not primed -> mock provider throws

    const outcome = await rewindShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome.recovered).toBe(false);
    expect(outcome.failure).toMatchObject({
      txId: 'tx3', index: 0, mode: 1, tokenId: '00', assetMismatch: false,
    });
    expect((await readOutput('tx3', 0)).recovery_state).toBe('recovery_failed');
    // Reported once per load by reportShieldedSweeps, not per output.
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('fails an amount-shielded output whose token id is missing', async () => {
    await insertShieldedOutput('tx4', 0, 'a1', 1, 'unowned');
    const out = amountOutput({ txId: 'tx4', tokenId: null }); // mode 1 must carry its token

    const outcome = await rewindShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome.recovered).toBe(false);
    expect((await readOutput('tx4', 0)).recovery_state).toBe('recovery_failed');
    expect(outcome.failure!.error).toContain('missing its token id');
  });

  it('fails a fully-shielded output whose asset commitment is missing', async () => {
    await insertShieldedOutput('tx5', 0, 'a1', 2, 'unowned');
    const out = amountOutput({ txId: 'tx5', mode: 2, assetCommitment: null }); // mode 2 needs it

    const outcome = await rewindShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome.recovered).toBe(false);
    expect((await readOutput('tx5', 0)).recovery_state).toBe('recovery_failed');
    expect(outcome.failure!.error).toContain('missing its asset commitment');
  });

  it('never rejects even if marking the failure throws', async () => {
    await insertShieldedOutput('tx6', 0, 'a1', 1, 'unowned');
    const out = amountOutput({ txId: 'tx6' }); // unprimed -> rewind throws
    const markSpy = jest.spyOn(ShieldedDb, 'markShieldedTxOutputRecoveryFailed')
      .mockRejectedValueOnce(new Error('connection lost'));

    // the mark throwing must not escape: resolves recovered:false, no rejection
    await expect(rewindShieldedOutput(mysql, 'w1', out, logger)).resolves.toEqual(
      expect.objectContaining({ txId: 'tx6', index: 0, recovered: false }),
    );
    // the mark never landed, so the row is left as it was, for the next catch-up
    expect((await readOutput('tx6', 0)).recovery_state).toBe('unowned');
    markSpy.mockRestore();
  });
});

/**
 * A shielded output the sweep can actually pick up: `getShieldedOutputsToRecover`
 * inner-joins the satellite row and a CTSpend `address` row carrying a scan key,
 * so a bare `tx_output` row alone would be invisible to it either way.
 */
const seedRecoverableOutput = async (txId: string, index: number, address: string) => {
  await insertShieldedOutput(txId, index, address, 1, 'unowned');
  await mysql.query(
    `INSERT INTO \`shielded_tx_output_data\`
       (\`tx_id\`, \`index\`, \`commitment\`, \`range_proof\`, \`script\`, \`ephemeral_pubkey\`, \`asset_commitment\`)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [txId, index, Buffer.alloc(33, 0xa1), Buffer.alloc(8, 0xb1), Buffer.alloc(1), Buffer.alloc(33, 0xc1)],
  );
};

describe('findAndRewindShielded with no crypto provider', () => {
  it('skips the sweep, leaves recoverable outputs unowned, and alerts once', async () => {
    // beforeEach registers the mock provider; drop it to reproduce production.
    clearShieldedCryptoProvider();
    await addToAddressTable(mysql, [{
      address: 'a1', index: 0, walletId: 'w1', transactions: 0,
      bip32_account: Bip32Account.CTSpend, scan_privkey: Buffer.alloc(32, 1),
    }]);
    // Two outputs the sweep would otherwise rewind and fail.
    await seedRecoverableOutput('tx1', 0, 'a1');
    await seedRecoverableOutput('tx1', 1, 'a1');

    // Sanity: without the short-circuit these rows ARE visible to the getter,
    // so the `unowned` assertions below are load-bearing.
    expect(await ShieldedDb.getShieldedOutputsToRecover(mysql, 'w1', 10)).toHaveLength(2);

    const getSpy = jest.spyOn(ShieldedDb, 'getShieldedOutputsToRecover');
    const failSpy = jest.spyOn(ShieldedDb, 'markShieldedTxOutputRecoveryFailed');

    const first = await findAndRewindShielded(mysql, 'w1', logger);
    const second = await findAndRewindShielded(mysql, 'w1', logger);

    expect(first).toStrictEqual({ recovered: 0, recoveries: [], failed: 0, missed: 0, misses: [], failures: [], skipped: true, truncated: false });
    expect(second).toStrictEqual({ recovered: 0, recoveries: [], failed: 0, missed: 0, misses: [], failures: [], skipped: true, truncated: false });
    expect(getSpy).not.toHaveBeenCalled();
    expect(failSpy).not.toHaveBeenCalled();

    // One alert for two outputs across two sweeps; the old code emitted one
    // MAJOR per output per sweep.
    expect(mockedAddAlert).toHaveBeenCalledTimes(1);
    expect(mockedAddAlert.mock.calls[0][0]).toBe('Shielded crypto provider not registered');
    expect(mockedAddAlert.mock.calls[0][2]).toBe(Severity.MAJOR);

    // Still `unowned`, not `recovery_failed`: the daemon's promote helper only
    // advances rows in that state, so failing them here would strand them.
    expect((await readOutput('tx1', 0)).recovery_state).toBe('unowned');
    expect((await readOutput('tx1', 1)).recovery_state).toBe('unowned');

    getSpy.mockRestore();
    failSpy.mockRestore();
  });

  it('reports the sweep as skipped so the caller leaves catch-up pending', async () => {
    clearShieldedCryptoProvider();

    const outcome = await findAndRewindShielded(mysql, 'w1', logger);

    // `skipped` is what distinguishes "could not even look" from "nothing to
    // do" — without it the load marks catch-up done and no later sweep retries.
    expect(outcome).toStrictEqual({ recovered: 0, recoveries: [], failed: 0, missed: 0, misses: [], failures: [], skipped: true, truncated: false });
  });

  it('reports a completed sweep as not skipped', async () => {
    // beforeEach leaves the mock provider registered.
    const outcome = await findAndRewindShielded(mysql, 'w1', logger);

    expect(outcome).toStrictEqual({ recovered: 0, recoveries: [], failed: 0, missed: 0, misses: [], failures: [], skipped: false, truncated: false });
  });
});

describe('scan misses', () => {
  const claim = () => addToAddressTable(mysql, [{
    address: 'a1', index: 0, walletId: 'w1', transactions: 0,
    bip32_account: Bip32Account.CTSpend, scan_privkey: Buffer.alloc(32, 1),
  }]);

  it.each(['unowned', 'recovery_failed'])(
    'leaves a %s output as it was and raises no per-output alert',
    async (state) => {
      await insertShieldedOutput('tx1', 0, 'a1', 1, state);
      const out = amountOutput();
      primeScanMiss({ commitment: out.commitment, ephemeralPubkey: out.ephemeralPubkey });

      const outcome = await rewindShieldedOutput(mysql, 'w1', out, logger);

      expect(outcome).toStrictEqual({ txId: 'tx1', index: 0, address: 'a1', recovered: false, missed: true });
      expect((await readOutput('tx1', 0)).recovery_state).toBe(state);
      expect(mockedAddAlert).not.toHaveBeenCalled();
    },
  );

  it('returns the misses of a sweep apart from its failures, without alerting', async () => {
    await claim();
    // Two outputs the scan key does not open, and one it does.
    for (const [index, fill] of [[0, 0xa1], [1, 0xa2], [2, 0xa3]]) {
      await insertShieldedOutput('tx1', index, 'a1', 1, 'unowned');
      await mysql.query("UPDATE `tx_output` SET `token_id` = '00' WHERE `tx_id` = 'tx1' AND `index` = ?", [index]);
      await mysql.query(
        `INSERT INTO \`shielded_tx_output_data\`
           (\`tx_id\`, \`index\`, \`commitment\`, \`range_proof\`, \`script\`, \`ephemeral_pubkey\`, \`asset_commitment\`)
         VALUES ('tx1', ?, ?, ?, ?, ?, NULL)`,
        [index, Buffer.alloc(33, fill), Buffer.alloc(8), Buffer.alloc(1), Buffer.alloc(33, fill)],
      );
    }
    primeScanMiss({ commitment: Buffer.alloc(33, 0xa1), ephemeralPubkey: Buffer.alloc(33, 0xa1) });
    primeScanMiss({ commitment: Buffer.alloc(33, 0xa2), ephemeralPubkey: Buffer.alloc(33, 0xa2) });
    primeAmountRewind({
      commitment: Buffer.alloc(33, 0xa3), ephemeralPubkey: Buffer.alloc(33, 0xa3),
      value: 5n, tokenUid: Buffer.alloc(32, 0),
    });

    const outcome = await findAndRewindShielded(mysql, 'w1', logger);

    expect(outcome).toMatchObject({ recovered: 1, failed: 0, missed: 2, skipped: false });
    expect(outcome.misses).toStrictEqual([
      { txId: 'tx1', index: 0, mode: 1, tokenId: '00' },
      { txId: 'tx1', index: 1, mode: 1, tokenId: '00' },
    ]);
    expect((await readOutput('tx1', 0)).recovery_state).toBe('unowned');
    expect((await readOutput('tx1', 1)).recovery_state).toBe('unowned');
    // The load reports them, once, on the wallet-level pattern.
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });
});

describe('reportShieldedSweeps', () => {
  const sweep = (over: Partial<SweepOutcome> = {}): SweepOutcome => ({
    recovered: 0, recoveries: [], failed: 0, missed: 0, misses: [], failures: [], skipped: false, truncated: false, ...over,
  });
  const ref = (txId: string, index = 0) => ({ txId, index, mode: 1 as const, tokenId: '00' });
  const failure = (txId: string, assetMismatch = false) => ({ ...ref(txId), address: 'a1', assetMismatch, error: 'boom' });
  const seedRecovered = async () => {
    await addToAddressTable(mysql, [{
      address: 'a1', index: 0, walletId: 'w1', transactions: 0,
      bip32_account: Bip32Account.CTSpend, scan_privkey: Buffer.alloc(32, 1),
    }]);
    await insertShieldedOutput('done', 0, 'a1', 1, 'recovered');
  };

  it('sends nothing when every output was recovered', async () => {
    await reportShieldedSweeps(mysql, 'w1', [sweep({ recovered: 2 }), sweep()], logger);

    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('pages once for the failures of both sweeps, counting each output once', async () => {
    // The settle sweep re-drives the first sweep's failures.
    const first = sweep({ failures: [failure('tx1'), failure('tx2')] });
    const settle = sweep({ failures: [failure('tx1'), failure('tx2')] });

    await reportShieldedSweeps(mysql, 'w1', [first, settle], logger);

    expect(mockedAddAlert).toHaveBeenCalledTimes(1);
    const [title, , severity, metadata] = mockedAddAlert.mock.calls[0];
    expect(title).toBe('Shielded recovery failed');
    expect(severity).toBe(Severity.MAJOR);
    expect(metadata).toMatchObject({ wallet_id: 'w1', count: 2 });
  });

  it('does not page when every failure is a sender-made asset mismatch', async () => {
    await reportShieldedSweeps(mysql, 'w1', [sweep({ failures: [failure('tx1', true)] })], logger);

    expect(mockedAddAlert.mock.calls[0][2]).toBe(Severity.MINOR);
  });

  it('pages on misses when the wallet has not a single recovered output', async () => {
    const misses = [ref('tx1'), ref('tx2')];

    await reportShieldedSweeps(mysql, 'w1', [sweep({ misses }), sweep({ misses })], logger);

    expect(mockedAddAlert).toHaveBeenCalledTimes(1);
    const [title, , severity, metadata] = mockedAddAlert.mock.calls[0];
    expect(title).toBe("Shielded outputs did not open with their wallet's scan key");
    expect(severity).toBe(Severity.MAJOR);
    expect(metadata).toMatchObject({ wallet_id: 'w1', missed: 2, recovered: 0 });
  });

  it('does not page on misses once the wallet has recovered an output', async () => {
    // Anyone can send a claimed address an output that will not open; a
    // wallet whose key opens its other outputs is not mismatched.
    await seedRecovered();

    await reportShieldedSweeps(mysql, 'w1', [sweep({ misses: [ref('tx1')] })], logger);

    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('never rejects when an alert fails to send', async () => {
    mockedAddAlert.mockRejectedValueOnce(new Error('sqs unavailable'));

    await expect(reportShieldedSweeps(mysql, 'w1', [sweep({ failures: [failure('tx1')] })], logger))
      .resolves.toBeUndefined();
  });
});
