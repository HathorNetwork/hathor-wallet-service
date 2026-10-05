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
import { resetCtCryptoMock, primeAmountRewind, primeFullyRewind } from '@tests/utils/ct-crypto-mock';
import { recoverShieldedOutput, findAndRewindShielded, resetMissingProviderAlert } from '@src/shieldedRecovery';
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

describe('recoverShieldedOutput', () => {
  it('recovers an amount-shielded output and marks it recovered', async () => {
    await insertShieldedOutput('tx1', 0, 'a1', 1, 'unowned');
    const out = amountOutput();
    primeAmountRewind({
      commitment: out.commitment, ephemeralPubkey: out.ephemeralPubkey, value: 1500n, tokenUid: Buffer.from('00', 'hex'),
    });

    const outcome = await recoverShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome).toEqual({ txId: 'tx1', index: 0, address: 'a1', recovered: true, tokenId: '00', value: 1500n });
    const row = await readOutput('tx1', 0);
    expect(row.recovery_state).toBe('recovered');
    expect(String(row.value)).toBe('1500');
    expect(row.token_id).toBe('00');
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('recovers a fully-shielded output, taking the token from the rewind', async () => {
    await insertShieldedOutput('tx2', 0, 'a1', 2, 'unowned');
    const out = amountOutput({
      txId: 'tx2', mode: 2, tokenId: null, assetCommitment: Buffer.alloc(33, 0xd2),
      commitment: Buffer.alloc(33, 0xa2), ephemeralPubkey: Buffer.alloc(33, 0xc2),
    });
    primeFullyRewind({
      commitment: out.commitment, ephemeralPubkey: out.ephemeralPubkey, value: 42n,
      tokenUid: Buffer.from('ab'.repeat(32), 'hex'), assetCommitment: out.assetCommitment!,
    });

    const outcome = await recoverShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome.recovered).toBe(true);
    const row = await readOutput('tx2', 0);
    expect(row.recovery_state).toBe('recovered');
    expect(row.token_id).toBe('ab'.repeat(32));
  });

  it('marks recovery_failed and alerts when the rewind throws (unprimed)', async () => {
    await insertShieldedOutput('tx3', 0, 'a1', 1, 'unowned');
    const out = amountOutput({ txId: 'tx3' }); // not primed -> mock provider throws

    const outcome = await recoverShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome.recovered).toBe(false);
    expect((await readOutput('tx3', 0)).recovery_state).toBe('recovery_failed');
    expect(mockedAddAlert).toHaveBeenCalledWith(
      'Shielded recovery failed',
      expect.stringContaining('tx3:0'),
      Severity.MAJOR,
      expect.objectContaining({ tx_id: 'tx3', index: 0, wallet_id: 'w1', source: 'wallet-service' }),
      logger,
    );
  });

  it('fails an amount-shielded output whose token id is missing', async () => {
    await insertShieldedOutput('tx4', 0, 'a1', 1, 'unowned');
    const out = amountOutput({ txId: 'tx4', tokenId: null }); // mode 1 must carry its token

    const outcome = await recoverShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome.recovered).toBe(false);
    expect((await readOutput('tx4', 0)).recovery_state).toBe('recovery_failed');
    expect(mockedAddAlert).toHaveBeenCalledWith(
      'Shielded recovery failed',
      expect.any(String),
      Severity.MAJOR,
      expect.objectContaining({ error: expect.stringContaining('missing its token id') }),
      logger,
    );
  });

  it('fails a fully-shielded output whose asset commitment is missing', async () => {
    await insertShieldedOutput('tx5', 0, 'a1', 2, 'unowned');
    const out = amountOutput({ txId: 'tx5', mode: 2, assetCommitment: null }); // mode 2 needs it

    const outcome = await recoverShieldedOutput(mysql, 'w1', out, logger);

    expect(outcome.recovered).toBe(false);
    expect((await readOutput('tx5', 0)).recovery_state).toBe('recovery_failed');
    expect(mockedAddAlert).toHaveBeenCalledWith(
      'Shielded recovery failed',
      expect.any(String),
      Severity.MAJOR,
      expect.objectContaining({ error: expect.stringContaining('missing its asset commitment') }),
      logger,
    );
  });

  it('never rejects even if failure-reporting (addAlert) throws', async () => {
    await insertShieldedOutput('tx6', 0, 'a1', 1, 'unowned');
    const out = amountOutput({ txId: 'tx6' }); // unprimed -> rewind throws
    mockedAddAlert.mockRejectedValueOnce(new Error('sqs unavailable'));

    // the reporting path throwing must not escape: resolves recovered:false, no rejection
    await expect(recoverShieldedOutput(mysql, 'w1', out, logger)).resolves.toEqual(
      expect.objectContaining({ txId: 'tx6', index: 0, recovered: false }),
    );
    // the mark ran before the alert threw, so the row is still left for re-drive
    expect((await readOutput('tx6', 0)).recovery_state).toBe('recovery_failed');
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

    expect(first).toStrictEqual({ recovered: 0, failed: 0, skipped: true });
    expect(second).toStrictEqual({ recovered: 0, failed: 0, skipped: true });
    expect(getSpy).not.toHaveBeenCalled();
    expect(failSpy).not.toHaveBeenCalled();

    // One alert for two outputs across two sweeps; the old code emitted one
    // MAJOR per output per sweep.
    expect(mockedAddAlert).toHaveBeenCalledTimes(1);
    expect(mockedAddAlert.mock.calls[0][0]).toBe('Shielded crypto provider not registered');
    expect(mockedAddAlert.mock.calls[0][2]).toBe(Severity.MINOR);

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
    expect(outcome).toStrictEqual({ recovered: 0, failed: 0, skipped: true });
  });

  it('reports a completed sweep as not skipped', async () => {
    // beforeEach leaves the mock provider registered.
    const outcome = await findAndRewindShielded(mysql, 'w1', logger);

    expect(outcome).toStrictEqual({ recovered: 0, failed: 0, skipped: false });
  });
});
