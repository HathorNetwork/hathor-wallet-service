/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';
import { addAlert, Severity } from '@wallet-service/common';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase } from '@tests/utils';
import { resetCtCryptoMock, primeAmountRewind, primeFullyRewind } from '@tests/utils/ct-crypto-mock';
import { recoverShieldedOutput } from '@src/shieldedRecovery';
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
});
