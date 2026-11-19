/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ServerlessMysql } from 'serverless-mysql';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { Bip32Account } from '@wallet-service/common';
import { cleanDatabase, addToAddressTable } from '@tests/utils';
import {
  lockWalletAddresses,
  rebuildShieldedAddressBalances,
  rebuildShieldedAddressTxHistory,
  rebuildWalletBalance,
  rebuildWalletTxHistory,
  pruneWalletTotals,
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
  c: { ub?: number; lb?: number; tr?: number; usb?: number; lsb?: number; tsr?: number; ua?: number; la?: number; te?: number | null },
) => mysql.query(
  `INSERT INTO \`address_balance\`
     (\`address\`, \`token_id\`, \`unlocked_balance\`, \`locked_balance\`, \`total_received\`,
      \`unlocked_shielded_balance\`, \`locked_shielded_balance\`, \`total_shielded_received\`,
      \`unlocked_authorities\`, \`locked_authorities\`, \`timelock_expires\`, \`transactions\`)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  [address, tokenId, c.ub ?? 0, c.lb ?? 0, c.tr ?? 0, c.usb ?? 0, c.lsb ?? 0, c.tsr ?? 0, c.ua ?? 0, c.la ?? 0, c.te ?? null],
);

const insertAddressHistoryRow = (address: string, txId: string, tokenId: string, balance: number, shieldedDelta: number, voided = false) => mysql.query(
  `INSERT INTO \`address_tx_history\`
     (\`address\`, \`tx_id\`, \`token_id\`, \`balance\`, \`shielded_balance_delta\`, \`timestamp\`, \`voided\`)
   VALUES (?, ?, ?, ?, ?, 0, ?)`,
  [address, txId, tokenId, balance, shieldedDelta, voided],
);

const readWalletBalance = async (walletId: string, tokenId: string) => (await mysql.query(
  `SELECT \`unlocked_balance\` AS ub, \`total_received\` AS tr, \`transactions\` AS txns,
          \`unlocked_shielded_balance\` AS usb, \`locked_shielded_balance\` AS lsb, \`total_shielded_received\` AS tsr,
          \`unlocked_authorities\` AS ua, \`locked_authorities\` AS la, \`timelock_expires\` AS te
     FROM \`wallet_balance\` WHERE \`wallet_id\` = ? AND \`token_id\` = ?`,
  [walletId, tokenId],
))[0];

// The rebuilds read the wallet's address set from its `address` rows. Each
// address gets its own derivation index, which (wallet, account, index) keys.
let nextAddressIndex = 0;
const ownAddresses = (walletId: string, addresses: string[], account: Bip32Account = Bip32Account.Legacy) => addToAddressTable(
  mysql,
  addresses.map((address) => {
    nextAddressIndex += 1;
    return { address, index: nextAddressIndex, walletId, transactions: 0, bip32_account: account };
  }),
);

// The order commitShieldedRecoveries runs them in, over the address set it
// reads: rebuildWalletBalance takes its transaction count from the history the
// two before it leave behind.
const rebuildWalletTotals = async (walletId: string) => {
  const addresses = (await lockWalletAddresses(mysql, walletId)).map((a) => a.address);
  await pruneWalletTotals(mysql, walletId, addresses);
  await rebuildWalletTxHistory(mysql, walletId);
  await rebuildWalletBalance(mysql, walletId);
};

const insertWalletHistoryRow = (walletId: string, txId: string, tokenId: string, voided = false) => mysql.query(
  `INSERT INTO \`wallet_tx_history\`
     (\`wallet_id\`, \`token_id\`, \`tx_id\`, \`balance\`, \`shielded_balance_delta\`, \`timestamp\`, \`voided\`)
   VALUES (?, ?, ?, 0, 0, 0, ?)`,
  [walletId, tokenId, txId, voided],
);

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('rebuildShieldedAddressBalances', () => {
  beforeEach(() => ownAddresses('w1', ['a1'], Bip32Account.CTSpend));

  it('recomputes shielded columns from recovered utxos: unspent-unlocked = balance, all recovered = lifetime', async () => {
    await insertOutput('rtx1', 0, 'a1', { value: '100' }); // unspent, unlocked
    await insertOutput('rtx2', 0, 'a1', { value: '50', spentBy: 'in0' }); // spent
    await insertOutput('rtx3', 0, 'a1', { value: '30', locked: true }); // unspent, locked
    await insertOutput('rtx4', 0, 'a1', { value: null, recoveryState: 'unowned' }); // not recovered
    await insertOutput('rtxV', 0, 'a1', { value: '999', voided: true }); // voided -> excluded

    await rebuildShieldedAddressBalances(mysql, 'w1');

    const ab = await readAddressBalance('a1', '00');
    expect(String(ab.u)).toBe('100'); // unlocked_shielded_balance
    expect(String(ab.l)).toBe('30'); // locked_shielded_balance
    expect(String(ab.t)).toBe('180'); // total_shielded_received (100+50+30, spent counts; voided 999 excluded)
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

    await rebuildShieldedAddressBalances(mysql, 'w1');
    await rebuildShieldedAddressBalances(mysql, 'w1'); // twice → same result

    const ab = await readAddressBalance('a1', '00');
    expect(String(ab.u)).toBe('100');
    expect(String(ab.tu)).toBe('777'); // transparent unlocked_balance preserved
  });

  // The daemon's void subtracts 1 from `transactions` for the voided tx, so a
  // pair the sweep credits must already be counted for it, or the void
  // underflows and halts sync.
  const readTransactions = async (address: string, tokenId: string) => Number((await mysql.query(
    'SELECT `transactions` FROM `address_balance` WHERE `address` = ? AND `token_id` = ?',
    [address, tokenId],
  ))[0].transactions);

  it('counts a new pair once per history row', async () => {
    await insertTx('rtx1', 1000);
    await insertOutput('rtx1', 0, 'a1', { value: '100' });

    await rebuildShieldedAddressTxHistory(mysql, 'w1');
    await rebuildShieldedAddressBalances(mysql, 'w1');

    expect(await readTransactions('a1', '00')).toBe(1);
  });

  it('adds the recovered receive to the count a transparent row already has, once', async () => {
    // The daemon already counted a transparent tx for this pair.
    await mysql.query(
      `INSERT INTO \`address_balance\`
         (\`address\`, \`token_id\`, \`unlocked_balance\`, \`locked_balance\`,
          \`unlocked_authorities\`, \`locked_authorities\`, \`transactions\`)
       VALUES ('a1', '00', 777, 0, 0, 0, 1)`,
    );
    await insertAddressHistoryRow('a1', 'ttx', '00', 777, 0);
    await insertTx('rtx1', 1000);
    await insertOutput('rtx1', 0, 'a1', { value: '100' });

    await rebuildShieldedAddressTxHistory(mysql, 'w1');
    await rebuildShieldedAddressBalances(mysql, 'w1');
    expect(await readTransactions('a1', '00')).toBe(2);

    // A re-run (a reload) counts nothing twice.
    await rebuildShieldedAddressTxHistory(mysql, 'w1');
    await rebuildShieldedAddressBalances(mysql, 'w1');
    expect(await readTransactions('a1', '00')).toBe(2);
  });

  it('does not count voided history rows', async () => {
    await insertTx('rtx1', 1000);
    await insertOutput('rtx1', 0, 'a1', { value: '100' });
    await insertAddressHistoryRow('a1', 'gone', '00', 5, 0, true);

    await rebuildShieldedAddressTxHistory(mysql, 'w1');
    await rebuildShieldedAddressBalances(mysql, 'w1');

    expect(await readTransactions('a1', '00')).toBe(1);
  });

  it('rebuilds only the wallet\'s CTSpend addresses, or just the ones it is given', async () => {
    await ownAddresses('w1', ['a2'], Bip32Account.CTSpend);
    await ownAddresses('w1', ['legacy']);
    await ownAddresses('w2', ['b1'], Bip32Account.CTSpend);
    for (const address of ['a1', 'a2', 'legacy', 'b1']) {
      await insertOutput(`rtx-${address}`, 0, address, { value: '100' });
    }

    await rebuildShieldedAddressBalances(mysql, 'w1', ['a1']);
    expect((await mysql.query('SELECT `address` FROM `address_balance`') as unknown as { address: string }[])
      .map((r) => r.address)).toEqual(['a1']);

    await rebuildShieldedAddressBalances(mysql, 'w1');
    expect((await mysql.query('SELECT `address` FROM `address_balance` ORDER BY `address`') as unknown as { address: string }[])
      .map((r) => r.address)).toEqual(['a1', 'a2']);
  });

  it('is a no-op for an empty list of addresses to rebuild', async () => {
    await insertOutput('rtx1', 0, 'a1', { value: '100' });
    await rebuildShieldedAddressBalances(mysql, 'w1', []);
    expect(Number((await mysql.query('SELECT COUNT(*) AS c FROM `address_balance`'))[0].c)).toBe(0);
  });
});

describe('rebuildShieldedAddressTxHistory', () => {
  beforeEach(() => ownAddresses('w1', ['a1'], Bip32Account.CTSpend));

  it('records the spend of a recovered output on its spending tx', async () => {
    // Recovered after the spend happened: the daemon never wrote that row.
    await insertTx('recv', 1000);
    await insertTx('spend', 2000);
    await insertOutput('recv', 0, 'a1', { value: '100', spentBy: 'spend' });

    await rebuildShieldedAddressTxHistory(mysql, 'w1');

    expect(String((await readAddressHistory('a1', 'recv', '00')).d)).toBe('100');
    const spendRow = await readAddressHistory('a1', 'spend', '00');
    expect(String(spendRow.d)).toBe('-100');
    expect(Number(spendRow.timestamp)).toBe(2000);
  });

  it('nets a tx that spends from and pays the same pair', async () => {
    // `mixed` spends the 100 received in `recv` and pays 30 back to a1.
    await insertTx('recv', 1000);
    await insertTx('mixed', 2000);
    await insertOutput('recv', 0, 'a1', { value: '100', spentBy: 'mixed' });
    await insertOutput('mixed', 0, 'a1', { value: '30' });

    await rebuildShieldedAddressTxHistory(mysql, 'w1');

    // The same delta the daemon writes for that tx, so a rebuild doesn't overwrite it.
    expect(String((await readAddressHistory('a1', 'mixed', '00')).d)).toBe('-70');
  });

  it('ignores a spend by a voided tx', async () => {
    await insertTx('recv', 1000);
    await mysql.query("INSERT INTO `transaction` (`tx_id`, `timestamp`, `version`, `voided`) VALUES ('gone', 2000, 1, TRUE)");
    await insertOutput('recv', 0, 'a1', { value: '100', spentBy: 'gone' });

    await rebuildShieldedAddressTxHistory(mysql, 'w1');

    expect(await readAddressHistory('a1', 'gone', '00')).toBeUndefined();
  });

  it('writes one shielded receive-delta per (address, tx, token) from recovered outputs', async () => {
    await insertTx('rtx1', 1000);
    await insertTx('rtx2', 2000);
    await insertOutput('rtx1', 0, 'a1', { value: '100' });
    await insertOutput('rtx2', 0, 'a1', { value: '40' });
    await insertOutput('rtx2', 1, 'a1', { value: '60' }); // same (addr, tx, token) → sums

    await rebuildShieldedAddressTxHistory(mysql, 'w1');

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

    await rebuildShieldedAddressTxHistory(mysql, 'w1');
    await rebuildShieldedAddressTxHistory(mysql, 'w1'); // twice

    const h = await readAddressHistory('a1', 'rtx1', '00');
    expect(String(h.d)).toBe('100'); // replaced, not 200
    expect(String(h.balance)).toBe('500'); // transparent balance preserved
  });

  it('rebuilds only the wallet\'s CTSpend addresses, or just the ones it is given', async () => {
    await ownAddresses('w1', ['a2'], Bip32Account.CTSpend);
    await ownAddresses('w1', ['legacy']);
    await ownAddresses('w2', ['b1'], Bip32Account.CTSpend);
    await insertTx('rtx1', 1000);
    for (const [index, address] of ['a1', 'a2', 'legacy', 'b1'].entries()) {
      await insertOutput('rtx1', index, address, { value: '100' });
    }

    await rebuildShieldedAddressTxHistory(mysql, 'w1', ['a1']);
    expect((await mysql.query('SELECT `address` FROM `address_tx_history`') as unknown as { address: string }[])
      .map((r) => r.address)).toEqual(['a1']);

    await rebuildShieldedAddressTxHistory(mysql, 'w1');
    expect((await mysql.query('SELECT `address` FROM `address_tx_history` ORDER BY `address`') as unknown as { address: string }[])
      .map((r) => r.address)).toEqual(['a1', 'a2']);
  });

  it('is a no-op for an empty list of addresses to rebuild', async () => {
    await insertTx('rtx1', 1000);
    await insertOutput('rtx1', 0, 'a1', { value: '100' });
    await rebuildShieldedAddressTxHistory(mysql, 'w1', []);
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

    await ownAddresses('w1', ['ta', 'ca']);
    await rebuildWalletTotals('w1');

    const wb = await readWalletBalance('w1', '00');
    expect(String(wb.ub)).toBe('200');
    expect(String(wb.tr)).toBe('200');
    expect(String(wb.usb)).toBe('100');
    expect(String(wb.tsr)).toBe('100');
    expect(Number(wb.txns)).toBe(2); // t1 + rtx1
  });

  it('folds authority bits (BIT_OR) and the earliest timelock (MIN) across addresses', async () => {
    await insertAddressBalance('a1', '00', { ua: 0b01, la: 0b00, te: 900 });
    await insertAddressBalance('a2', '00', { ua: 0b10, la: 0b01, te: 500 });

    await ownAddresses('w1', ['a1', 'a2']);
    await rebuildWalletBalance(mysql, 'w1');

    const wb = await readWalletBalance('w1', '00');
    expect(Number(wb.ua)).toBe(0b11); // BIT_OR(01, 10)
    expect(Number(wb.la)).toBe(0b01); // BIT_OR(00, 01)
    expect(Number(wb.te)).toBe(500); // MIN(900, 500)
  });

  it('counts a tx touching two wallet addresses once', async () => {
    await insertAddressBalance('a1', '00', { usb: 100, tsr: 100 });
    await insertAddressBalance('a2', '00', { usb: 50, tsr: 50 });
    await insertAddressHistoryRow('a1', 'shared', '00', 0, 100); // same tx on both addresses
    await insertAddressHistoryRow('a2', 'shared', '00', 0, 50);

    await ownAddresses('w1', ['a1', 'a2']);
    await rebuildWalletTotals('w1');

    expect(Number((await readWalletBalance('w1', '00')).txns)).toBe(1); // counted per address it would be 2
  });

  it('counts a tx with two tokens once per token', async () => {
    await insertAddressBalance('a1', '00', { ub: 10, tr: 10 });
    await insertAddressBalance('a1', 't1', { ub: 5, tr: 5 });
    await insertAddressHistoryRow('a1', 'multi', '00', 10, 0);
    await insertAddressHistoryRow('a1', 'multi', 't1', 5, 0);
    await insertAddressHistoryRow('a1', 'other', 't1', 0, 0);

    await ownAddresses('w1', ['a1']);
    await rebuildWalletTotals('w1');

    expect(Number((await readWalletBalance('w1', '00')).txns)).toBe(1);
    expect(Number((await readWalletBalance('w1', 't1')).txns)).toBe(2);
  });

  it('does not count a voided address-history row', async () => {
    await insertAddressBalance('a1', '00', { ub: 10, tr: 10 });
    await insertAddressHistoryRow('a1', 'live', '00', 10, 0);
    await insertAddressHistoryRow('a1', 'gone', '00', 7, 0, true);

    await ownAddresses('w1', ['a1']);
    await rebuildWalletTotals('w1');

    expect(Number((await readWalletBalance('w1', '00')).txns)).toBe(1);
  });

  it('takes the transaction count from the wallet\'s rebuilt history', async () => {
    // rebuildWalletBalance counts the rows the history rebuild left, so it must
    // run after it; here the history holds two rows no address row backs.
    await insertAddressBalance('a1', '00', { ub: 10, tr: 10 });
    await insertWalletHistoryRow('w1', 'h1', '00');
    await insertWalletHistoryRow('w1', 'h2', '00');

    await ownAddresses('w1', ['a1']);
    await rebuildWalletBalance(mysql, 'w1');

    expect(Number((await readWalletBalance('w1', '00')).txns)).toBe(2);
  });

  it('counts a backed wallet-history row even when it carries a stale voided flag', async () => {
    // The history rebuild does not reset `voided` on a row that already exists,
    // and the pair is still a non-voided tx of the wallet's addresses.
    await insertAddressBalance('a1', '00', { ub: 10, tr: 10 });
    await insertAddressHistoryRow('a1', 'tx1', '00', 10, 0);
    await insertWalletHistoryRow('w1', 'tx1', '00', true);

    await ownAddresses('w1', ['a1']);
    await rebuildWalletTotals('w1');

    expect(Number((await readWalletBalance('w1', '00')).txns)).toBe(1);
  });

  it('does not count a wallet-history row the prune removes', async () => {
    await insertAddressBalance('a1', '00', { ub: 10, tr: 10 });
    await insertAddressHistoryRow('a1', 'tx1', '00', 10, 0);
    await insertWalletHistoryRow('w1', 'stale', '00');

    await ownAddresses('w1', ['a1']);
    await rebuildWalletTotals('w1');

    expect(Number((await readWalletBalance('w1', '00')).txns)).toBe(1);
  });

  it('is idempotent', async () => {
    await insertAddressBalance('ca', '00', { usb: 100, tsr: 100 });
    await insertAddressHistoryRow('ca', 'rtx1', '00', 0, 100);

    await ownAddresses('w1', ['ca']);
    await rebuildWalletTotals('w1');
    await rebuildWalletTotals('w1');

    const wb = await readWalletBalance('w1', '00');
    expect(String(wb.usb)).toBe('100');
    expect(Number(wb.txns)).toBe(1);
  });

  it('totals only the wallet\'s own addresses', async () => {
    await insertAddressBalance('a1', '00', { ub: 10, tr: 10 });
    await insertAddressBalance('b1', '00', { ub: 99, tr: 99 }); // another wallet's
    await insertAddressBalance('b1', 't1', { ub: 5, tr: 5 });
    await insertAddressHistoryRow('a1', 'tx1', '00', 10, 0);
    await insertAddressHistoryRow('b1', 'tx2', '00', 99, 0);
    await ownAddresses('w1', ['a1']);
    await ownAddresses('w2', ['b1']);
    // Left from before b1's token t1 was ever the wallet's: the prune drops it.
    await mysql.query(
      `INSERT INTO \`wallet_balance\` (\`wallet_id\`, \`token_id\`, \`unlocked_balance\`, \`locked_balance\`, \`transactions\`)
       VALUES ('w1', 't1', 5, 0, 1)`,
    );

    await rebuildWalletTotals('w1');

    const wb = await readWalletBalance('w1', '00');
    expect(String(wb.ub)).toBe('10');
    expect(Number(wb.txns)).toBe(1);
    expect(await readWalletBalance('w1', 't1')).toBeUndefined();
  });

  it('is a no-op for a wallet with no addresses', async () => {
    await insertAddressBalance('elsewhere', '00', { ub: 10, tr: 10 });

    await rebuildWalletBalance(mysql, 'w1');

    expect(Number((await mysql.query('SELECT COUNT(*) AS c FROM `wallet_balance`'))[0].c)).toBe(0);
  });
});

describe('rebuildWalletTxHistory', () => {
  it('aggregates transparent balance + shielded delta per (tx, token) across the wallet addresses', async () => {
    await insertAddressHistoryRow('ta', 't1', '00', 200, 0); // transparent-only tx
    await insertAddressHistoryRow('ca', 'rtx1', '00', 0, 100); // shielded-only tx
    await insertAddressHistoryRow('ta', 'shared', '00', 50, 0); // same tx spans two addresses
    await insertAddressHistoryRow('ca', 'shared', '00', 30, 0);

    await ownAddresses('w1', ['ta', 'ca']);
    await rebuildWalletTxHistory(mysql, 'w1');

    const read = async (txId: string) => (await mysql.query(
      'SELECT `balance` AS b, `shielded_balance_delta` AS d FROM `wallet_tx_history` WHERE `wallet_id` = ? AND `token_id` = ? AND `tx_id` = ?',
      ['w1', '00', txId],
    ))[0];
    expect(String((await read('t1')).b)).toBe('200');
    expect(String((await read('rtx1')).d)).toBe('100');
    expect(String((await read('shared')).b)).toBe('80'); // 50 + 30
  });

  it('excludes voided address-history rows from the wallet aggregation', async () => {
    await insertAddressHistoryRow('ca', 'good', '00', 0, 100);
    await insertAddressHistoryRow('ca', 'bad', '00', 0, 999, true); // voided -> excluded

    await ownAddresses('w1', ['ca']);
    await rebuildWalletTxHistory(mysql, 'w1');

    const rows = await mysql.query('SELECT `tx_id` FROM `wallet_tx_history` WHERE `wallet_id` = ?', ['w1']);
    expect((rows as { tx_id: string }[]).map((r) => r.tx_id)).toEqual(['good']);
  });

  it('is idempotent', async () => {
    await insertAddressHistoryRow('ca', 'rtx1', '00', 0, 100);

    await ownAddresses('w1', ['ca']);
    await rebuildWalletTxHistory(mysql, 'w1');
    await rebuildWalletTxHistory(mysql, 'w1');

    const row = (await mysql.query(
      'SELECT `shielded_balance_delta` AS d FROM `wallet_tx_history` WHERE `wallet_id` = ? AND `token_id` = ? AND `tx_id` = ?',
      ['w1', '00', 'rtx1'],
    ))[0];
    expect(String(row.d)).toBe('100');
  });

  it('aggregates only the wallet\'s own addresses', async () => {
    await insertAddressHistoryRow('a1', 'shared', '00', 10, 0);
    await insertAddressHistoryRow('b1', 'shared', '00', 99, 0); // another wallet's, same tx
    await insertAddressHistoryRow('b1', 'theirs', '00', 7, 0);
    await ownAddresses('w1', ['a1']);
    await ownAddresses('w2', ['b1']);

    await rebuildWalletTxHistory(mysql, 'w1');

    const rows = await mysql.query(
      'SELECT `tx_id`, `balance` AS b FROM `wallet_tx_history` WHERE `wallet_id` = ?', ['w1'],
    ) as unknown as { tx_id: string; b: string }[];
    expect(rows.map((r) => [r.tx_id, String(r.b)])).toEqual([['shared', '10']]);
  });

  it('is a no-op for a wallet with no addresses', async () => {
    await insertAddressHistoryRow('elsewhere', 't1', '00', 10, 0);

    await rebuildWalletTxHistory(mysql, 'w1');

    expect(Number((await mysql.query('SELECT COUNT(*) AS c FROM `wallet_tx_history`'))[0].c)).toBe(0);
  });
});
