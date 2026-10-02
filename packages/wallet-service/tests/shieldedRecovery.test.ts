/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';
import { addAlert, Severity, clearShieldedCryptoProvider } from '@wallet-service/common';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase } from '@tests/utils';
import { resetCtCryptoMock, primeAmountRewind, primeFullyRewind } from '@tests/utils/ct-crypto-mock';
import { recoverShieldedOutput, findAndRewindShielded } from '@src/shieldedRecovery';
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

describe('findAndRewindShielded with no crypto provider', () => {
  // A single test on purpose: the missing-provider alert is latched in module
  // state that is never reset, so only the first sweep in a process can observe
  // the latch being taken. Splitting this would make the later cases assert on
  // an already-consumed latch.
  it('skips the sweep, leaves outputs unowned, and alerts once but retries a failed alert', async () => {
    // beforeEach registers the mock provider; drop it to reproduce production.
    clearShieldedCryptoProvider();
    await insertShieldedOutput('tx1', 0, 'a1', 1, 'unowned');
    await insertShieldedOutput('tx1', 1, 'a1', 1, 'unowned');
    const getSpy = jest.spyOn(ShieldedDb, 'getShieldedOutputsToRecover');
    const failSpy = jest.spyOn(ShieldedDb, 'markShieldedTxOutputRecoveryFailed');

    // First attempt fails to emit: that must not consume the latch, or the
    // operator would never learn the provider is missing.
    mockedAddAlert.mockRejectedValueOnce(new Error('sqs unavailable'));

    const first = await findAndRewindShielded(mysql, 'w1', logger);
    const second = await findAndRewindShielded(mysql, 'w2', logger);
    const third = await findAndRewindShielded(mysql, 'w3', logger);

    for (const result of [first, second, third]) {
      expect(result).toStrictEqual({ recovered: 0, failed: 0 });
    }
    // The sweep never reaches the database and never fails an output.
    expect(getSpy).not.toHaveBeenCalled();
    expect(failSpy).not.toHaveBeenCalled();

    // Two attempts: the failed one, then the one that stuck. The third sweep is
    // silent — the old code emitted one MAJOR per output per sweep.
    expect(mockedAddAlert).toHaveBeenCalledTimes(2);
    expect(mockedAddAlert.mock.calls[1][0]).toBe('Shielded crypto provider not registered');
    expect(mockedAddAlert.mock.calls[1][2]).toBe(Severity.MAJOR);

    // The rows must stay `unowned`: `recovery_failed` is unreachable for the
    // daemon's promote helper, so a later catch-up could never pick them up.
    expect((await readOutput('tx1', 0)).recovery_state).toBe('unowned');
    expect((await readOutput('tx1', 1)).recovery_state).toBe('unowned');

    getSpy.mockRestore();
    failSpy.mockRestore();
  });
});
