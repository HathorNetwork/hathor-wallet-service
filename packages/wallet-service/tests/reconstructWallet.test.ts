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
import {
  sweptOutputs, findAndRewindShielded, reconstructWallet, commitShieldedRecoveries, runRecoveryTransaction,
} from '@src/shieldedRecovery';
import * as ShieldedDb from '@src/db/shielded';

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
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xa1), ephemeralPubkey: Buffer.alloc(33, 0xa1), value: 100n, tokenUid: Buffer.alloc(32, 0) });
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xa2), ephemeralPubkey: Buffer.alloc(33, 0xa2), value: 250n, tokenUid: Buffer.alloc(32, 0) });

    const result = await findAndRewindShielded(mysql, 'w1', logger, 2); // pageSize 2 → forces >1 page

    expect(result).toMatchObject({ recovered: 2, failed: 1, missed: 0, skipped: false });
    expect(result.recoveries).toStrictEqual([
      { txId: 'o1', index: 0, address: 'ca', value: 100n, tokenId: '00' },
      { txId: 'o2', index: 0, address: 'ca', value: 250n, tokenId: '00' },
    ]);
    // Opened, but promoted only by the commit, with the balance rebuilds.
    expect((await readState('o1')).s).toBe('unowned');
    // A failure is recorded straight away: it changes no balance.
    expect((await readState('o3')).s).toBe('recovery_failed');
    // Returned for the load to report once, not alerted per output.
    expect(result.failures).toStrictEqual([expect.objectContaining({ txId: 'o3', index: 0 })]);
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('is a no-op when the wallet has no unowned shielded outputs', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);

    expect(await findAndRewindShielded(mysql, 'w1', logger)).toMatchObject({ recovered: 0, failed: 0, missed: 0, skipped: false });
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
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xf1), ephemeralPubkey: Buffer.alloc(33, 0xf1), value: 500n, tokenUid: Buffer.alloc(32, 0) });

    const result = await findAndRewindShielded(mysql, 'w1', logger);

    expect(result).toMatchObject({ recovered: 1, failed: 0, missed: 0, skipped: false });
    expect(result.recoveries).toStrictEqual([{ txId: 'f1', index: 0, address: 'ca', value: 500n, tokenId: '00' }]);
  });

  it('skips outputs an earlier sweep of the same load handled', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);
    for (const [tx, byte] of [['o1', 0xa1], ['o2', 0xa2]] as [string, number][]) {
      await insertUnownedOutput(tx, 'ca', '00');
      await insertSatellite(tx, Buffer.alloc(33, byte), Buffer.alloc(33, byte));
      primeAmountRewind({
        commitment: Buffer.alloc(33, byte), ephemeralPubkey: Buffer.alloc(33, byte), value: 1n, tokenUid: Buffer.alloc(32, 0),
      });
    }
    const first = await findAndRewindShielded(mysql, 'w1', logger);

    const settle = await findAndRewindShielded(mysql, 'w1', logger, undefined, { exclude: sweptOutputs(first) });

    expect(first.recovered).toBe(2);
    // Both are still unpromoted, so without the exclusion they'd be rewound again.
    expect(settle.recovered).toBe(0);
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
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xb1), ephemeralPubkey: Buffer.alloc(33, 0xb1), value: 100n, tokenUid: Buffer.alloc(32, 0) });
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xb2), ephemeralPubkey: Buffer.alloc(33, 0xb2), value: 250n, tokenUid: Buffer.alloc(32, 0) });

    await reconstructWallet(mysql, 'w1', logger);

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

    await reconstructWallet(mysql, 'w1', logger);

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
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xb1), ephemeralPubkey: Buffer.alloc(33, 0xb1), value: 100n, tokenUid: Buffer.alloc(32, 0) });
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xb2), ephemeralPubkey: Buffer.alloc(33, 0xb2), value: 250n, tokenUid: Buffer.alloc(32, 0) });

    const first = await reconstructWallet(mysql, 'w1', logger);
    expect(first).toMatchObject({ recovered: 2, failed: 0, missed: 0, skipped: false });
    // second pass: outputs are already 'recovered', so nothing is rewound and the
    // rebuilds re-snapshot (replace, not add)
    const second = await reconstructWallet(mysql, 'w1', logger);
    expect(second).toMatchObject({ recovered: 0, failed: 0, missed: 0, skipped: false });

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
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xc1), ephemeralPubkey: Buffer.alloc(33, 0xc1), value: 100n, tokenUid: Buffer.alloc(32, 0) });
    primeFullyRewind({ commitment: Buffer.alloc(33, 0xc2), ephemeralPubkey: Buffer.alloc(33, 0xc2), value: 42n, tokenUid: Buffer.from(tokenB, 'hex'), assetCommitment: Buffer.alloc(33, 0xd2) });

    expect(await reconstructWallet(mysql, 'w1', logger)).toMatchObject({ recovered: 2, failed: 0, missed: 0, skipped: false });

    expect(String((await readWalletBalance('w1')).usb)).toBe('100'); // token '00' row
    const wbB = (await mysql.query(
      "SELECT `unlocked_shielded_balance` AS usb FROM `wallet_balance` WHERE `wallet_id` = 'w1' AND `token_id` = ?", [tokenB],
    ))[0];
    expect(String(wbB.usb)).toBe('42'); // recovered token -> second GROUP BY token_id row
  });

  it('folds a fully-shielded HTR output onto the canonical "00" token row', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);
    await insertTx('h1', 800);
    await insertTx('h2', 810);
    // A transparent/amount-shielded HTR receive and a fully-shielded HTR receive
    // must land on the SAME token_id '00' row, not a separate all-zero-uid row.
    await insertUnownedOutput('h1', 'ca', '00', 1); // mode-1 HTR
    await insertSatellite('h1', Buffer.alloc(33, 0xe1), Buffer.alloc(33, 0xe1));
    await insertUnownedOutput('h2', 'ca', null, 2); // mode-2 HTR — token from the rewind
    await insertSatellite('h2', Buffer.alloc(33, 0xe2), Buffer.alloc(33, 0xe2), Buffer.alloc(33, 0xf2));
    primeAmountRewind({ commitment: Buffer.alloc(33, 0xe1), ephemeralPubkey: Buffer.alloc(33, 0xe1), value: 100n, tokenUid: Buffer.alloc(32, 0) });
    // The native token's raw on-chain uid is 32 zero bytes.
    primeFullyRewind({ commitment: Buffer.alloc(33, 0xe2), ephemeralPubkey: Buffer.alloc(33, 0xe2), value: 42n, tokenUid: Buffer.alloc(32, 0), assetCommitment: Buffer.alloc(33, 0xf2) });

    expect(await reconstructWallet(mysql, 'w1', logger)).toMatchObject({ recovered: 2, failed: 0, missed: 0, skipped: false });

    // Both receives fold onto the single '00' row: 100 + 42 = 142.
    expect(String((await readWalletBalance('w1')).usb)).toBe('142');
    const rows = await mysql.query("SELECT `token_id` FROM `wallet_balance` WHERE `wallet_id` = 'w1'");
    expect(rows).toHaveLength(1); // no stray all-zero-uid token row
    expect((rows as { token_id: string }[])[0].token_id).toBe('00');
  });
});

describe('commitShieldedRecoveries', () => {
  // One opened output to the wallet's CTSpend address 'ca', ready to commit.
  const sweepOne = async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);
    await insertTx('o1', 1000);
    await insertUnownedOutput('o1', 'ca', '00');
    await insertSatellite('o1', Buffer.alloc(33, 0xa1), Buffer.alloc(33, 0xa1));
    primeAmountRewind({
      commitment: Buffer.alloc(33, 0xa1), ephemeralPubkey: Buffer.alloc(33, 0xa1), value: 100n, tokenUid: Buffer.alloc(32, 0),
    });
    return findAndRewindShielded(mysql, 'w1', logger);
  };
  const readAddressBalance = async () => (await mysql.query(
    "SELECT `unlocked_shielded_balance` AS usb, `transactions` AS txns FROM `address_balance` WHERE `address` = 'ca' AND `token_id` = '00'",
  ))[0];

  it('promotes and credits in the same commit', async () => {
    const sweep = await sweepOne();

    const promoted = await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', sweep.recoveries));

    expect(promoted).toBe(1);
    expect((await readState('o1')).s).toBe('recovered');
    expect(await readAddressBalance()).toMatchObject({ usb: '100' });
    expect(String((await readWalletBalance('w1')).usb)).toBe('100');
  });

  it('leaves nothing promoted or credited when the commit fails', async () => {
    const sweep = await sweepOne();
    const spy = jest.spyOn(ShieldedDb, 'rebuildWalletBalance').mockRejectedValueOnce(new Error('connection lost'));

    await expect(runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', sweep.recoveries)))
      .rejects.toThrow('connection lost');
    spy.mockRestore();

    // A promoted but uncredited output is what halts the daemon on its next
    // spend, unlock or void of it.
    expect((await readState('o1')).s).toBe('unowned');
    expect(await readAddressBalance()).toBeUndefined();
  });

  it('credits an output once when its recovery is committed twice', async () => {
    const sweep = await sweepOne();
    await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', sweep.recoveries));

    const second = await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', sweep.recoveries));

    expect(second).toBe(0);
    expect(await readAddressBalance()).toMatchObject({ usb: '100' });
    expect(Number((await readAddressBalance()).txns)).toBe(1);
  });

  it('does not promote an output voided between its rewind and the commit', async () => {
    const sweep = await sweepOne();
    await mysql.query("UPDATE `tx_output` SET `voided` = TRUE WHERE `tx_id` = 'o1'");

    const promoted = await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', sweep.recoveries));

    expect(promoted).toBe(0);
    expect((await readState('o1')).s).toBe('unowned');
  });

  it('totals every address the wallet has when it commits, not when it swept', async () => {
    const sweep = await sweepOne();
    // The daemon claims and credits another address for the wallet in between.
    await seedTransparentAddress('ta', 'w1', 0);
    await seedTransparentBalance('ta', 'ttx');

    await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', sweep.recoveries));

    expect(await readWalletBalance('w1')).toMatchObject({ ub: '200', usb: '100' });
  });
});

describe('runRecoveryTransaction', () => {
  const lockError = (errno: number) => Object.assign(new Error(`lock error ${errno}`), { errno });

  it.each([1213, 1205])('runs the whole transaction again after a lock conflict (errno %i)', async (errno) => {
    await seedWallet('w1');
    let attempts = 0;

    const result = await runRecoveryTransaction(mysql, logger, async (tx) => {
      attempts += 1;
      await tx.query("UPDATE `wallet` SET `max_gap` = `max_gap` + 1 WHERE `id` = 'w1'");
      if (attempts === 1) throw lockError(errno);
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(attempts).toBe(2);
    // The first attempt's write was rolled back, so it applied once.
    const [wallet] = await mysql.query("SELECT `max_gap` FROM `wallet` WHERE `id` = 'w1'") as unknown as { max_gap: number }[];
    expect(Number(wallet.max_gap)).toBe(21);
  });

  it('caps each lock wait when asked', async () => {
    try {
      const wait = await runRecoveryTransaction(mysql, logger, async (tx) => {
        const [row] = await tx.query('SELECT @@SESSION.innodb_lock_wait_timeout AS w') as unknown as { w: number }[];
        return Number(row.w);
      }, { lockWaitSeconds: 3 });

      expect(wait).toBe(3);
    } finally {
      await mysql.query('SET SESSION innodb_lock_wait_timeout = DEFAULT');
    }
  });

  it('does not run again after a lock conflict once the caller\'s budget is spent', async () => {
    let attempts = 0;

    await expect(runRecoveryTransaction(mysql, logger, async () => {
      attempts += 1;
      throw lockError(1205);
    }, { canRetry: () => false })).rejects.toMatchObject({ errno: 1205 });

    expect(attempts).toBe(1);
  });

  it('fails, leaving nothing behind, when its connection is lost midway', async () => {
    // serverless-mysql would re-run the next statement on a new connection,
    // outside the transaction, and commit it on its own; the pinned handle
    // must fail instead.
    await seedWallet('w1');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mysql2 = require('mysql2/promise');
    const killer = await mysql2.createConnection({
      host: process.env.DB_ENDPOINT,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
    });
    try {
      await expect(runRecoveryTransaction(mysql, logger, async (tx) => {
        await tx.query("UPDATE `wallet` SET `max_gap` = 31 WHERE `id` = 'w1'");
        const [{ id }] = await tx.query('SELECT CONNECTION_ID() AS id') as unknown as { id: number }[];
        await killer.query(`KILL CONNECTION ${Number(id)}`);
        await tx.query("UPDATE `wallet` SET `max_gap` = 32 WHERE `id` = 'w1'");
      })).rejects.toBeDefined();
    } finally {
      await killer.end();
    }

    const [wallet] = await mysql.query("SELECT `max_gap` FROM `wallet` WHERE `id` = 'w1'") as unknown as { max_gap: number }[];
    expect(Number(wallet.max_gap)).toBe(20);
  });

  it('does not retry any other error', async () => {
    let attempts = 0;

    await expect(runRecoveryTransaction(mysql, logger, async () => {
      attempts += 1;
      throw new Error('out of range');
    })).rejects.toThrow('out of range');

    expect(attempts).toBe(1);
  });
});

describe('promoteShieldedTxOutputs', () => {
  it('promotes across batches and counts only rows it changed', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);
    // More than one batch of 500, seeded in one statement.
    const recoveries = Array.from({ length: 520 }, (_, i) => ({
      txId: `b${i}`, index: 0, address: 'ca', value: BigInt(i + 1), tokenId: '00',
    }));
    await mysql.query(
      `INSERT INTO \`tx_output\`
         (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
          \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`mode\`, \`recovery_state\`)
       VALUES ?`,
      [recoveries.map((r) => [r.txId, 0, 'ca', null, '00', 0, null, null, false, false, 1, 'unowned'])],
    );
    await mysql.query("UPDATE `tx_output` SET `voided` = TRUE WHERE `tx_id` = 'b7'");
    await mysql.query("UPDATE `tx_output` SET `recovery_state` = 'recovered', `value` = 8 WHERE `tx_id` = 'b8'");

    const promoted = await ShieldedDb.promoteShieldedTxOutputs(mysql, recoveries);

    expect(promoted).toBe(518);
    expect(await readState('b519')).toMatchObject({ s: 'recovered', v: '520' });
    expect((await readState('b7')).s).toBe('unowned');
  });
});
