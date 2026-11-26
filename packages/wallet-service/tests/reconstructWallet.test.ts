/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';
import { addAlert, Bip32Account, Severity } from '@wallet-service/common';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase, addToWalletTable, addToAddressTable } from '@tests/utils';
import { resetCtCryptoMock, primeAmountRewind, primeFullyRewind } from '@tests/utils/ct-crypto-mock';
import {
  sweptOutputs, findAndRewindShielded, reconstructWallet, commitShieldedRecoveries, runRecoveryTransaction, runSettle,
} from '@src/shieldedRecovery';
import * as ShieldedDb from '@src/db/shielded';
import config from '@src/config';

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

  it('counts the wallet\'s transactions without a history row its addresses no longer back', async () => {
    await seedWallet('w1');
    await seedTransparentAddress('ta', 'w1', 0);
    await seedTransparentBalance('ta', 'ttx');
    // Left over from a tx voided while the wallet was mid-load.
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (\`wallet_id\`, \`token_id\`, \`tx_id\`, \`balance\`, \`timestamp\`, \`voided\`)
       VALUES ('w1', '00', 'gone', 5, 400, FALSE)`,
    );

    await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', []));

    expect(await countWalletHistory('w1')).toBe(1);
    expect(Number((await readWalletBalance('w1')).txns)).toBe(1);
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

describe('commitShieldedRecoveries lock footprint', () => {
  const ER_LOCK_WAIT_TIMEOUT = 1205;
  const ER_LOCK_NOWAIT = 3572;

  // A wallet with more addresses than the range optimizer's memory holds
  // (`range_optimizer_max_mem_size`: about 9k to 13k addresses at the 8 MB
  // default) can't be read by an `address IN (...)` range, and a scan of the
  // whole table locks every row it passes. A 1-byte limit makes any list
  // overflow it, so a one-address wallet stands in for a wide one.
  it.each([
    ['a full settle', false],
    ['a catch-up', true],
  ])('holds only the wallet\'s own rows, however many addresses it has, in %s', async (_, onlyPromoted) => {
    await seedWallet('w1');
    // Two of each kind, so each list is a real range rather than one key lookup.
    await seedTransparentAddress('Ha', 'w1', 0);
    await seedTransparentBalance('Ha', 'tx1');
    await seedTransparentAddress('Hb', 'w1', 1);
    await seedTransparentBalance('Hb', 'tx1');
    await seedCtSpendAddress('Hc', 'w1', 0);
    await seedCtSpendAddress('Hd', 'w1', 1);
    // An output the settle promotes, so the shielded rebuilds have work to do.
    await insertTx('o1', 1000);
    await insertUnownedOutput('o1', 'Hc', '00');
    const recovery = { txId: 'o1', index: 0, address: 'Hc', value: 100n, tokenId: '00' };
    // A row the prune checks and drops.
    await mysql.query(
      `INSERT INTO \`wallet_tx_history\` (\`wallet_id\`, \`token_id\`, \`tx_id\`, \`balance\`, \`timestamp\`, \`voided\`)
       VALUES ('w1', '00', 'stale', 5, 400, FALSE)`,
    );
    // Between the two wallets' rows, so the next-key lock past w1's last row
    // lands here rather than on w2's first.
    await seedWallet('w3');
    await seedTransparentAddress('Hm', 'w3', 0);
    await seedTransparentBalance('Hm', 'tx2');
    await insertUnownedOutput('om', 'Hm', '00');
    await seedWallet('w2');
    await seedTransparentAddress('Hz', 'w2', 0);
    await seedTransparentBalance('Hz', 'tx3');
    await insertUnownedOutput('oz', 'Hz', '00');

    const settle = getDbConnection();
    const probe = getDbConnection();
    try {
      await settle.query('SET SESSION range_optimizer_max_mem_size = 1');
      await settle.query('START TRANSACTION');
      await commitShieldedRecoveries(settle, 'w1', [recovery], { onlyPromoted });
      await probe.query('SET SESSION innodb_lock_wait_timeout = 1');

      // Another wallet's rows stay free, so the daemon keeps syncing it.
      await expect(probe.query(
        "SELECT 1 FROM `address_balance` WHERE `address` = 'Hz' FOR UPDATE NOWAIT",
      )).resolves.toBeDefined();
      await expect(probe.query(
        "SELECT 1 FROM `address_tx_history` WHERE `address` = 'Hz' FOR UPDATE NOWAIT",
      )).resolves.toBeDefined();
      await expect(probe.query(
        "SELECT 1 FROM `tx_output` WHERE `tx_id` = 'oz' FOR UPDATE NOWAIT",
      )).resolves.toBeDefined();
      // A new history row for it goes into every index of the table.
      await expect(probe.query(
        `INSERT INTO \`address_tx_history\` (\`address\`, \`tx_id\`, \`token_id\`, \`balance\`, \`timestamp\`, \`voided\`)
         VALUES ('Hz', 'tx9', '00', 1, 900, FALSE)`,
      )).resolves.toBeDefined();
      // Every step ran: in the settle's own view, the prune dropped 'stale'
      // and the rebuilds added the transparent and the recovered transaction.
      expect((await settle.query(
        "SELECT `tx_id` FROM `wallet_tx_history` WHERE `wallet_id` = 'w1' ORDER BY `tx_id`",
      ) as unknown as { tx_id: string }[]).map((r) => r.tx_id)).toEqual(['o1', 'tx1']);
      // The wallet's own rows are held, including a token pair it doesn't have
      // yet. The history row is only read by the settle, so this also shows
      // the probes see its shared locks.
      await expect(probe.query(
        "SELECT 1 FROM `address_balance` WHERE `address` = 'Ha' FOR UPDATE NOWAIT",
      )).rejects.toMatchObject({ errno: ER_LOCK_NOWAIT });
      await expect(probe.query(
        "SELECT 1 FROM `address_tx_history` WHERE `address` = 'Ha' FOR UPDATE NOWAIT",
      )).rejects.toMatchObject({ errno: ER_LOCK_NOWAIT });
      await expect(probe.query(
        `INSERT INTO \`address_balance\` (\`address\`, \`token_id\`, \`unlocked_balance\`, \`locked_balance\`,
           \`total_received\`, \`unlocked_authorities\`, \`locked_authorities\`, \`timelock_expires\`, \`transactions\`)
         VALUES ('Ha', 't9', 1, 0, 1, 0, 0, NULL, 1)`,
      )).rejects.toMatchObject({ errno: ER_LOCK_WAIT_TIMEOUT });
    } finally {
      await settle.query('ROLLBACK').finally(() => Promise.all([
        closeDbConnection(settle), closeDbConnection(probe),
      ]));
    }
  }, 30000);
});

describe('commitShieldedRecoveries step timings', () => {
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

  it('reports every step of a full settle once, in order', async () => {
    const sweep = await sweepOne();
    const steps: [string, number][] = [];

    await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', sweep.recoveries, {
      finishSweep: true,
      onStep: (step, ms) => { steps.push([step, ms]); },
    }));

    expect(steps.map(([step]) => step)).toEqual([
      'lockAddresses', 'finishSweep', 'promote', 'lockBalances',
      'rebuildShieldedHistory', 'rebuildShieldedBalances',
      'prune', 'rebuildWalletTxHistory', 'rebuildWalletBalance',
    ]);
    expect(steps.every(([, ms]) => ms >= 0)).toBe(true);
  });

  it('reports only the steps that ran when a catch-up promotes nothing', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('ca', 'w1', 0);
    const steps: string[] = [];

    await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', [], {
      onlyPromoted: true,
      onStep: (step) => { steps.push(step); },
    }));

    expect(steps).toEqual(['lockAddresses', 'promote']);
  });

  it('commits the settle when the step hook throws', async () => {
    const sweep = await sweepOne();

    const promoted = await runRecoveryTransaction(mysql, logger, (tx) => commitShieldedRecoveries(tx, 'w1', sweep.recoveries, {
      onStep: () => { throw new Error('hook boom'); },
    }));

    expect(promoted).toBe(1);
    expect((await readState('o1')).s).toBe('recovered');
    expect(String((await readWalletBalance('w1')).usb)).toBe('100');
  });
});

describe('runSettle', () => {
  const lockError = (errno: number) => Object.assign(new Error(`lock error ${errno}`), { errno });
  const spyLogger = () => ({
    debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
  });
  const infoCalls = (log: ReturnType<typeof spyLogger>, message: string) => (
    log.info.mock.calls.filter(([m]) => m === message).map(([, meta]) => meta)
  );
  const readMaxGap = async () => Number(((await mysql.query(
    "SELECT `max_gap` FROM `wallet` WHERE `id` = 'w1'",
  )) as unknown as { max_gap: number }[])[0].max_gap);
  const defaultAlertMs = config.loadSettleAlertMs;

  afterEach(() => {
    config.loadSettleAlertMs = defaultAlertMs;
  });

  it('logs each step as it completes and a summary, with the wallet and the caller', async () => {
    await seedWallet('w1');
    await seedTransparentAddress('ta', 'w1', 0);
    await seedTransparentBalance('ta', 'ttx');
    const log = spyLogger();

    await runSettle(mysql, log as unknown as Logger, { walletId: 'w1', source: 'load' }, (tx, onStep) => (
      commitShieldedRecoveries(tx, 'w1', [], { onStep })
    ));

    expect(infoCalls(log, 'Settle started')).toEqual([{ walletId: 'w1', source: 'load' }]);
    const steps = infoCalls(log, 'Settle step');
    expect(steps.map((meta) => meta.step)).toEqual([
      'lockAddresses', 'promote', 'lockBalances', 'rebuildShieldedHistory', 'rebuildShieldedBalances',
      'prune', 'rebuildWalletTxHistory', 'rebuildWalletBalance',
    ]);
    expect(steps.every((meta) => meta.walletId === 'w1' && meta.source === 'load' && meta.attempt === 1)).toBe(true);
    const [summary] = infoCalls(log, 'Settle finished');
    expect(summary).toMatchObject({ walletId: 'w1', source: 'load', attempts: 1 });
    expect(Object.keys(summary.stepsMs)).toContain('rebuildWalletTxHistory');
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('counts attempts and adds up step time across a lock-conflict re-run', async () => {
    await seedWallet('w1');
    const log = spyLogger();
    let attempts = 0;

    await runSettle(mysql, log as unknown as Logger, { walletId: 'w1', source: 'sweep' }, async (tx, onStep) => {
      attempts += 1;
      onStep('work', attempts === 1 ? 5 : 7);
      await tx.query("UPDATE `wallet` SET `max_gap` = `max_gap` + 1 WHERE `id` = 'w1'");
      if (attempts === 1) throw lockError(1213);
    });

    const [summary] = infoCalls(log, 'Settle finished');
    expect(summary).toMatchObject({ attempts: 2, stepsMs: { work: 12 } });
    expect(infoCalls(log, 'Settle step').map((meta) => meta.attempt)).toEqual([1, 2]);
    expect(await readMaxGap()).toBe(21);
  });

  it('alerts after the commit when the settle reaches the threshold', async () => {
    await seedWallet('w1');
    config.loadSettleAlertMs = 0;

    await runSettle(mysql, logger, { walletId: 'w1', source: 'failed-upgrade' }, async (tx, onStep) => {
      onStep('work', 3);
      await tx.query("UPDATE `wallet` SET `max_gap` = 25 WHERE `id` = 'w1'");
    });

    expect(mockedAddAlert).toHaveBeenCalledTimes(1);
    const [title, , severity, metadata] = mockedAddAlert.mock.calls[0];
    expect(title).toBe('Slow wallet settle');
    expect(severity).toBe(Severity.MINOR);
    expect(metadata).toMatchObject({ wallet_id: 'w1', settle_source: 'failed-upgrade', attempts: 1, source: 'wallet-service' });
    expect(JSON.parse(metadata.steps_ms)).toEqual({ work: 3 });
    expect(await readMaxGap()).toBe(25);
  });

  it('keeps the commit and resolves when the slow-settle alert throws', async () => {
    await seedWallet('w1');
    config.loadSettleAlertMs = 0;
    mockedAddAlert.mockRejectedValueOnce(new Error('alert queue down'));
    const log = spyLogger();

    const result = await runSettle(mysql, log as unknown as Logger, { walletId: 'w1', source: 'load' }, async (tx) => {
      await tx.query("UPDATE `wallet` SET `max_gap` = 26 WHERE `id` = 'w1'");
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(await readMaxGap()).toBe(26);
    expect(log.error).toHaveBeenCalledWith('Failed to send the slow-settle alert', expect.objectContaining({ walletId: 'w1' }));
  });

  it('logs and rethrows a failed settle, without alerting', async () => {
    await seedWallet('w1');
    config.loadSettleAlertMs = 0;
    const log = spyLogger();
    const failure = Object.assign(new Error('out of range'), { errno: 1690, code: 'ER_DATA_OUT_OF_RANGE' });

    await expect(runSettle(mysql, log as unknown as Logger, { walletId: 'w1', source: 'load' }, async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(log.warn).toHaveBeenCalledWith('Settle failed', expect.objectContaining({
      walletId: 'w1', source: 'load', attempts: 1, errno: 1690, code: 'ER_DATA_OUT_OF_RANGE',
    }));
    expect(mockedAddAlert).not.toHaveBeenCalled();
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
