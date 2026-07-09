/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';
import { addAlert, Bip32Account } from '@wallet-service/common';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase, addToWalletTable, addToAddressTable } from '@tests/utils';
import { resetCtCryptoMock, primeAmountRewind, primeFullyRewind } from '@tests/utils/ct-crypto-mock';
import { findAndRewindShielded, reconstructWallet } from '@src/shieldedRecovery';

jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: jest.fn().mockResolvedValue(undefined),
}));
const mockedAddAlert = addAlert as jest.Mock;

const mysql: ServerlessMysql = getDbConnection();
const logger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} } as unknown as Logger;

const seedWallet = (id: string) => addToWalletTable(mysql, [{
  id, xpubkey: 'xpub-' + id, authXpubkey: 'auth-' + id, status: 'ready', maxGap: 20, createdAt: 1, readyAt: 1,
}]);

const seedCtSpendAddress = (address: string, walletId: string, index: number) =>
  addToAddressTable(mysql, [{
    address, index, walletId, transactions: 0, bip32_account: Bip32Account.CTSpend, scan_privkey: Buffer.alloc(32, index + 1),
  }]);

const insertUnownedOutput = (txId: string, address: string, tokenId: string | null, mode = 1) => mysql.query(
  `INSERT INTO \`tx_output\`
     (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
      \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`mode\`, \`recovery_state\`)
   VALUES (?, 0, ?, NULL, ?, 0, NULL, NULL, FALSE, FALSE, ?, 'unowned')`,
  [txId, address, tokenId, mode],
);

const insertSatellite = (txId: string, commitment: Buffer, ephemeralPubkey: Buffer, assetCommitment: Buffer | null = null) => mysql.query(
  `INSERT INTO \`shielded_tx_output_data\`
     (\`tx_id\`, \`index\`, \`commitment\`, \`range_proof\`, \`script\`, \`ephemeral_pubkey\`, \`asset_commitment\`)
   VALUES (?, 0, ?, ?, ?, ?, ?)`,
  [txId, commitment, Buffer.alloc(8), Buffer.alloc(1), ephemeralPubkey, assetCommitment],
);

const readState = async (txId: string) => (await mysql.query(
  'SELECT `recovery_state` AS s, `value` AS v FROM `tx_output` WHERE `tx_id` = ? AND `index` = 0', [txId],
))[0];

const insertTx = (txId: string, timestamp: number) => mysql.query(
  'INSERT INTO `transaction` (`tx_id`, `timestamp`, `version`, `voided`) VALUES (?, ?, 1, FALSE)', [txId, timestamp],
);

const seedTransparentAddress = (address: string, walletId: string, index: number) =>
  addToAddressTable(mysql, [{ address, index, walletId, transactions: 1, bip32_account: Bip32Account.Legacy }]);

// simulate the daemon's already-maintained transparent rows for a claimed address
const seedTransparentBalance = async (address: string, txId: string) => {
  await mysql.query(
    `INSERT INTO \`address_balance\` (\`address\`, \`token_id\`, \`unlocked_balance\`, \`locked_balance\`,
       \`total_received\`, \`unlocked_authorities\`, \`locked_authorities\`, \`timelock_expires\`, \`transactions\`)
     VALUES (?, '00', 200, 0, 200, 0, 0, NULL, 1)`, [address],
  );
  await mysql.query(
    `INSERT INTO \`address_tx_history\` (\`address\`, \`tx_id\`, \`token_id\`, \`balance\`, \`shielded_balance_delta\`, \`timestamp\`, \`voided\`)
     VALUES (?, ?, '00', 200, 0, 500, FALSE)`, [address, txId],
  );
};

const readWalletBalance = async (walletId: string) => (await mysql.query(
  `SELECT \`unlocked_balance\` AS ub, \`unlocked_shielded_balance\` AS usb, \`transactions\` AS txns
     FROM \`wallet_balance\` WHERE \`wallet_id\` = ? AND \`token_id\` = '00'`, [walletId],
))[0];

const countWalletHistory = async (walletId: string) => Number((await mysql.query(
  'SELECT COUNT(*) AS c FROM `wallet_tx_history` WHERE `wallet_id` = ?', [walletId],
))[0].c);

beforeEach(async () => {
  await cleanDatabase(mysql);
  resetCtCryptoMock();
  mockedAddAlert.mockClear();
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('findAndRewindShielded', () => {
  it('rewinds every unowned output for the wallet, recovering the primed ones and failing the rest', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);
    for (const [tx, byte] of [['o1', 0xa1], ['o2', 0xa2], ['o3', 0xa3]] as [string, number][]) {
      await insertUnownedOutput(tx, 'ca', '00');
      await insertSatellite(tx, Buffer.alloc(33, byte), Buffer.alloc(33, byte));
    }
    // prime o1 + o2, leave o3 unprimed (rewind throws → recovery_failed + alert)
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xa1), ephemeralPubkey: Buffer.alloc(33, 0xa1), value: 100n, tokenUid: Buffer.from('00', 'hex') });
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xa2), ephemeralPubkey: Buffer.alloc(33, 0xa2), value: 250n, tokenUid: Buffer.from('00', 'hex') });

    const result = await findAndRewindShielded(mysql, 'w1', logger, 2); // pageSize 2 → forces >1 page

    expect(result).toEqual({ recovered: 2, failed: 1 });
    expect((await readState('o1')).s).toBe('recovered');
    expect(String((await readState('o1')).v)).toBe('100');
    expect((await readState('o3')).s).toBe('recovery_failed');
    expect(mockedAddAlert).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the wallet has no unowned shielded outputs', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);

    expect(await findAndRewindShielded(mysql, 'w1', logger)).toEqual({ recovered: 0, failed: 0 });
  });

  it('re-drives a previously recovery_failed output (no reset needed)', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);
    await mysql.query(
      `INSERT INTO \`tx_output\`
         (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
          \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`mode\`, \`recovery_state\`)
       VALUES ('f1', 0, 'ca', NULL, '00', 0, NULL, NULL, FALSE, FALSE, 1, 'recovery_failed')`,
    );
    await insertSatellite('f1', Buffer.alloc(33, 0xf1), Buffer.alloc(33, 0xf1));
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xf1), ephemeralPubkey: Buffer.alloc(33, 0xf1), value: 500n, tokenUid: Buffer.from('00', 'hex') });

    const result = await findAndRewindShielded(mysql, 'w1', logger);

    expect(result).toEqual({ recovered: 1, failed: 0 });
    expect((await readState('f1')).s).toBe('recovered');
  });
});

describe('reconstructWallet', () => {
  it('recovers shielded outputs and folds them into the wallet balance/history alongside transparent', async () => {
    await seedWallet('w1');
    await seedTransparentAddress('ta', 'w1', 0);
    await seedCtSpendAddress('ca', 'w1', 0);
    await insertTx('t1', 500); // transparent tx (already in daemon history)
    await seedTransparentBalance('ta', 't1');

    for (const [tx, byte, ts] of [['so1', 0xb1, 600], ['so2', 0xb2, 700]] as [string, number, number][]) {
      await insertTx(tx, ts);
      await insertUnownedOutput(tx, 'ca', '00');
      await insertSatellite(tx, Buffer.alloc(33, byte), Buffer.alloc(33, byte));
    }
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xb1), ephemeralPubkey: Buffer.alloc(33, 0xb1), value: 100n, tokenUid: Buffer.from('00', 'hex') });
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xb2), ephemeralPubkey: Buffer.alloc(33, 0xb2), value: 250n, tokenUid: Buffer.from('00', 'hex') });

    await reconstructWallet(mysql, 'w1', ['ta'], ['ca'], logger);

    expect((await readState('so1')).s).toBe('recovered');
    const wb = await readWalletBalance('w1');
    expect(String(wb.ub)).toBe('200'); // transparent, from 'ta'
    expect(String(wb.usb)).toBe('350'); // shielded 100 + 250, from 'ca'
    expect(Number(wb.txns)).toBe(3); // t1 + so1 + so2
    expect(await countWalletHistory('w1')).toBe(3);
  });

  it('reconstructs transparent-only when no CT addresses are given (old client)', async () => {
    await seedWallet('w1');
    await seedTransparentAddress('ta', 'w1', 0);
    await insertTx('t1', 500);
    await seedTransparentBalance('ta', 't1');

    await reconstructWallet(mysql, 'w1', ['ta'], [], logger);

    const wb = await readWalletBalance('w1');
    expect(String(wb.ub)).toBe('200');
    expect(String(wb.usb)).toBe('0');
    expect(Number(wb.txns)).toBe(1);
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('is idempotent end-to-end (safe to re-run)', async () => {
    await seedWallet('w1');
    await seedTransparentAddress('ta', 'w1', 0);
    await seedCtSpendAddress('ca', 'w1', 0);
    await insertTx('t1', 500);
    await seedTransparentBalance('ta', 't1');
    for (const [tx, byte, ts] of [['so1', 0xb1, 600], ['so2', 0xb2, 700]] as [string, number, number][]) {
      await insertTx(tx, ts);
      await insertUnownedOutput(tx, 'ca', '00');
      await insertSatellite(tx, Buffer.alloc(33, byte), Buffer.alloc(33, byte));
    }
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xb1), ephemeralPubkey: Buffer.alloc(33, 0xb1), value: 100n, tokenUid: Buffer.from('00', 'hex') });
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xb2), ephemeralPubkey: Buffer.alloc(33, 0xb2), value: 250n, tokenUid: Buffer.from('00', 'hex') });

    const first = await reconstructWallet(mysql, 'w1', ['ta'], ['ca'], logger);
    expect(first).toEqual({ recovered: 2, failed: 0 });
    // second pass: outputs are already 'recovered', so nothing is rewound and the
    // rebuilds re-snapshot (replace, not add)
    const second = await reconstructWallet(mysql, 'w1', ['ta'], ['ca'], logger);
    expect(second).toEqual({ recovered: 0, failed: 0 });

    const wb = await readWalletBalance('w1');
    expect(String(wb.usb)).toBe('350'); // 100 + 250, not doubled
    expect(Number(wb.txns)).toBe(3); // t1 + so1 + so2
    expect(await countWalletHistory('w1')).toBe(3);
  });

  it('recovers a fully-shielded (mode 2) output and folds a second token via GROUP BY token_id', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);
    const tokenB = 'ab'.repeat(32);
    await insertTx('m1', 600);
    await insertTx('m2', 700);
    await insertUnownedOutput('m1', 'ca', '00', 1); // mode-1, token 00
    await insertSatellite('m1', Buffer.alloc(33, 0xc1), Buffer.alloc(33, 0xc1));
    await insertUnownedOutput('m2', 'ca', null, 2); // mode-2, token comes from the rewind
    await insertSatellite('m2', Buffer.alloc(33, 0xc2), Buffer.alloc(33, 0xc2), Buffer.alloc(33, 0xd2));
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xc1), ephemeralPubkey: Buffer.alloc(33, 0xc1), value: 100n, tokenUid: Buffer.from('00', 'hex') });
    primeFullyRewind({ commitment: Buffer.alloc(33, 0xc2), ephemeralPubkey: Buffer.alloc(33, 0xc2), value: 42n, tokenUid: Buffer.from(tokenB, 'hex'), assetCommitment: Buffer.alloc(33, 0xd2) });

    expect(await reconstructWallet(mysql, 'w1', [], ['ca'], logger)).toEqual({ recovered: 2, failed: 0 });

    expect(String((await readWalletBalance('w1')).usb)).toBe('100'); // token '00' row
    const wbB = (await mysql.query(
      "SELECT `unlocked_shielded_balance` AS usb FROM `wallet_balance` WHERE `wallet_id` = 'w1' AND `token_id` = ?", [tokenB],
    ))[0];
    expect(String(wbB.usb)).toBe('42'); // recovered token -> second GROUP BY token_id row
  });
});
