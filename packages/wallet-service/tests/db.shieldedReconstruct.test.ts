/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ServerlessMysql } from 'serverless-mysql';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase } from '@tests/utils';
import {
  rebuildShieldedAddressBalances,
  rebuildShieldedAddressTxHistory,
  rebuildWalletBalance,
  rebuildWalletTxHistory,
} from '@src/db/shielded';

const mysql: ServerlessMysql = getDbConnection();

interface OutputOpts {
  value: string | null;
  tokenId?: string;
  spentBy?: string | null;
  locked?: boolean;
  mode?: number;
  recoveryState?: string;
  voided?: boolean;
}

const insertOutput = (txId: string, index: number, address: string, o: OutputOpts) => mysql.query(
  `INSERT INTO \`tx_output\`
     (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
      \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`spent_by\`, \`mode\`, \`recovery_state\`)
   VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, ?)`,
  [
    txId, index, address, o.value, o.tokenId ?? '00',
    o.locked ?? false, o.voided ?? false, o.spentBy ?? null,
    o.mode ?? 1, o.recoveryState ?? 'recovered',
  ],
);

const insertTx = (txId: string, timestamp: number) => mysql.query(
  'INSERT INTO `transaction` (`tx_id`, `timestamp`, `version`, `voided`) VALUES (?, ?, 1, FALSE)',
  [txId, timestamp],
);

const readAddressHistory = async (address: string, txId: string, tokenId: string) => (await mysql.query(
  'SELECT `balance`, `shielded_balance_delta` AS d, `timestamp` FROM `address_tx_history` WHERE `address` = ? AND `tx_id` = ? AND `token_id` = ?',
  [address, txId, tokenId],
))[0];

const readAddressBalance = async (address: string, tokenId: string) => (await mysql.query(
  `SELECT \`unlocked_shielded_balance\` AS u, \`locked_shielded_balance\` AS l,
          \`total_shielded_received\` AS t, \`unlocked_balance\` AS tu
     FROM \`address_balance\` WHERE \`address\` = ? AND \`token_id\` = ?`,
  [address, tokenId],
))[0];

const insertAddressBalance = (
  address: string, tokenId: string,
  c: { ub?: number; lb?: number; tr?: number; usb?: number; lsb?: number; tsr?: number },
) => mysql.query(
  `INSERT INTO \`address_balance\`
     (\`address\`, \`token_id\`, \`unlocked_balance\`, \`locked_balance\`, \`total_received\`,
      \`unlocked_shielded_balance\`, \`locked_shielded_balance\`, \`total_shielded_received\`,
      \`unlocked_authorities\`, \`locked_authorities\`, \`timelock_expires\`, \`transactions\`)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 0)`,
  [address, tokenId, c.ub ?? 0, c.lb ?? 0, c.tr ?? 0, c.usb ?? 0, c.lsb ?? 0, c.tsr ?? 0],
);

const insertAddressHistoryRow = (address: string, txId: string, tokenId: string, balance: number, shieldedDelta: number) => mysql.query(
  `INSERT INTO \`address_tx_history\`
     (\`address\`, \`tx_id\`, \`token_id\`, \`balance\`, \`shielded_balance_delta\`, \`timestamp\`, \`voided\`)
   VALUES (?, ?, ?, ?, ?, 0, FALSE)`,
  [address, txId, tokenId, balance, shieldedDelta],
);

const readWalletBalance = async (walletId: string, tokenId: string) => (await mysql.query(
  `SELECT \`unlocked_balance\` AS ub, \`total_received\` AS tr, \`transactions\` AS txns,
          \`unlocked_shielded_balance\` AS usb, \`locked_shielded_balance\` AS lsb, \`total_shielded_received\` AS tsr
     FROM \`wallet_balance\` WHERE \`wallet_id\` = ? AND \`token_id\` = ?`,
  [walletId, tokenId],
))[0];

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('rebuildShieldedAddressBalances', () => {
  it('recomputes shielded columns from recovered utxos: unspent-unlocked = balance, all recovered = lifetime', async () => {
    await insertOutput('rtx1', 0, 'a1', { value: '100' }); // unspent, unlocked
    await insertOutput('rtx2', 0, 'a1', { value: '50', spentBy: 'in0' }); // spent
    await insertOutput('rtx3', 0, 'a1', { value: '30', locked: true }); // unspent, locked
    await insertOutput('rtx4', 0, 'a1', { value: null, recoveryState: 'unowned' }); // not recovered

    await rebuildShieldedAddressBalances(mysql, ['a1']);

    const ab = await readAddressBalance('a1', '00');
    expect(String(ab.u)).toBe('100'); // unlocked_shielded_balance
    expect(String(ab.l)).toBe('30'); // locked_shielded_balance
    expect(String(ab.t)).toBe('180'); // total_shielded_received (100+50+30, spent counts)
  });

  it('is idempotent and leaves the transparent balance untouched', async () => {
    // pre-existing transparent balance on the same (address, token) row
    await mysql.query(
      `INSERT INTO \`address_balance\`
         (\`address\`, \`token_id\`, \`unlocked_balance\`, \`locked_balance\`,
          \`unlocked_authorities\`, \`locked_authorities\`, \`transactions\`)
       VALUES ('a1', '00', 777, 0, 0, 0, 1)`,
    );
    await insertOutput('rtx1', 0, 'a1', { value: '100' });

    await rebuildShieldedAddressBalances(mysql, ['a1']);
    await rebuildShieldedAddressBalances(mysql, ['a1']); // twice → same result

    const ab = await readAddressBalance('a1', '00');
    expect(String(ab.u)).toBe('100');
    expect(String(ab.tu)).toBe('777'); // transparent unlocked_balance preserved
  });

  it('is a no-op for an empty address list', async () => {
    await rebuildShieldedAddressBalances(mysql, []);
    expect(Number((await mysql.query('SELECT COUNT(*) AS c FROM `address_balance`'))[0].c)).toBe(0);
  });
});

describe('rebuildShieldedAddressTxHistory', () => {
  it('writes one shielded receive-delta per (address, tx, token) from recovered outputs', async () => {
    await insertTx('rtx1', 1000);
    await insertTx('rtx2', 2000);
    await insertOutput('rtx1', 0, 'a1', { value: '100' });
    await insertOutput('rtx2', 0, 'a1', { value: '40' });
    await insertOutput('rtx2', 1, 'a1', { value: '60' }); // same (addr, tx, token) → sums

    await rebuildShieldedAddressTxHistory(mysql, ['a1']);

    const h1 = await readAddressHistory('a1', 'rtx1', '00');
    expect(String(h1.d)).toBe('100');
    expect(h1.timestamp).toBe(1000);
    expect(String(h1.balance)).toBe('0');
    const h2 = await readAddressHistory('a1', 'rtx2', '00');
    expect(String(h2.d)).toBe('100'); // 40 + 60
    expect(h2.timestamp).toBe(2000);
  });

  it('is idempotent (replaces, does not accumulate) and preserves an existing transparent row', async () => {
    await insertTx('rtx1', 1000);
    await mysql.query(
      "INSERT INTO `address_tx_history` (`address`, `tx_id`, `token_id`, `balance`, `timestamp`, `voided`) VALUES ('a1','rtx1','00', 500, 1000, FALSE)",
    );
    await insertOutput('rtx1', 0, 'a1', { value: '100' });

    await rebuildShieldedAddressTxHistory(mysql, ['a1']);
    await rebuildShieldedAddressTxHistory(mysql, ['a1']); // twice

    const h = await readAddressHistory('a1', 'rtx1', '00');
    expect(String(h.d)).toBe('100'); // replaced, not 200
    expect(String(h.balance)).toBe('500'); // transparent balance preserved
  });

  it('is a no-op for an empty address list', async () => {
    await rebuildShieldedAddressTxHistory(mysql, []);
    expect(Number((await mysql.query('SELECT COUNT(*) AS c FROM `address_tx_history`'))[0].c)).toBe(0);
  });
});

describe('rebuildWalletBalance', () => {
  it('aggregates transparent + shielded columns over the wallet addresses, tx count from history', async () => {
    // transparent address + shielded (CTSpend) address, same token
    await insertAddressBalance('ta', '00', { ub: 200, tr: 200 });
    await insertAddressBalance('ca', '00', { usb: 100, tsr: 100 });
    await insertAddressHistoryRow('ta', 't1', '00', 200, 0); // transparent tx
    await insertAddressHistoryRow('ca', 'rtx1', '00', 0, 100); // shielded tx

    await rebuildWalletBalance(mysql, 'w1', ['ta', 'ca']);

    const wb = await readWalletBalance('w1', '00');
    expect(String(wb.ub)).toBe('200');
    expect(String(wb.tr)).toBe('200');
    expect(String(wb.usb)).toBe('100');
    expect(String(wb.tsr)).toBe('100');
    expect(Number(wb.txns)).toBe(2); // t1 + rtx1
  });

  it('is idempotent', async () => {
    await insertAddressBalance('ca', '00', { usb: 100, tsr: 100 });
    await insertAddressHistoryRow('ca', 'rtx1', '00', 0, 100);

    await rebuildWalletBalance(mysql, 'w1', ['ca']);
    await rebuildWalletBalance(mysql, 'w1', ['ca']);

    const wb = await readWalletBalance('w1', '00');
    expect(String(wb.usb)).toBe('100');
    expect(Number(wb.txns)).toBe(1);
  });

  it('is a no-op for an empty address list', async () => {
    await rebuildWalletBalance(mysql, 'w1', []);
    expect(Number((await mysql.query('SELECT COUNT(*) AS c FROM `wallet_balance`'))[0].c)).toBe(0);
  });
});

describe('rebuildWalletTxHistory', () => {
  it('aggregates transparent balance + shielded delta per (tx, token) across the wallet addresses', async () => {
    await insertAddressHistoryRow('ta', 't1', '00', 200, 0); // transparent-only tx
    await insertAddressHistoryRow('ca', 'rtx1', '00', 0, 100); // shielded-only tx
    await insertAddressHistoryRow('ta', 'shared', '00', 50, 0); // same tx spans two addresses
    await insertAddressHistoryRow('ca', 'shared', '00', 30, 0);

    await rebuildWalletTxHistory(mysql, 'w1', ['ta', 'ca']);

    const read = async (txId: string) => (await mysql.query(
      'SELECT `balance` AS b, `shielded_balance_delta` AS d FROM `wallet_tx_history` WHERE `wallet_id` = ? AND `token_id` = ? AND `tx_id` = ?',
      ['w1', '00', txId],
    ))[0];
    expect(String((await read('t1')).b)).toBe('200');
    expect(String((await read('rtx1')).d)).toBe('100');
    expect(String((await read('shared')).b)).toBe('80'); // 50 + 30
  });

  it('is idempotent', async () => {
    await insertAddressHistoryRow('ca', 'rtx1', '00', 0, 100);

    await rebuildWalletTxHistory(mysql, 'w1', ['ca']);
    await rebuildWalletTxHistory(mysql, 'w1', ['ca']);

    const row = (await mysql.query(
      'SELECT `shielded_balance_delta` AS d FROM `wallet_tx_history` WHERE `wallet_id` = ? AND `token_id` = ? AND `tx_id` = ?',
      ['w1', '00', 'rtx1'],
    ))[0];
    expect(String(row.d)).toBe('100');
  });

  it('is a no-op for an empty address list', async () => {
    await rebuildWalletTxHistory(mysql, 'w1', []);
    expect(Number((await mysql.query('SELECT COUNT(*) AS c FROM `wallet_tx_history`'))[0].c)).toBe(0);
  });
});
