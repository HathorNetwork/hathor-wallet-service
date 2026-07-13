/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ServerlessMysql } from 'serverless-mysql';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { Network } from '@hathor/wallet-lib';
import { Bip32Account } from '@wallet-service/common';
import { deriveCtAddress } from '@wallet-service/common/src/crypto/shieldedAddress';
import { DbSelectResult } from '@src/types';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase, addToWalletTable, addToAddressTable } from '@tests/utils';
import {
  findShieldedAddressOwnership,
  findShieldedAddressOwnershipBatch,
  markShieldedTxOutputRecovered,
  markShieldedTxOutputRecoveryFailed,
  getShieldedOutputsToRecover,
  upsertShieldedAddressOwnership,
  getWalletCtSpendAddresses,
  markShieldedCatchupDone,
  generateShieldedAddresses,
} from '@src/db/shielded';

const mysql: ServerlessMysql = getDbConnection();

const seedWallet = (id: string) => addToWalletTable(mysql, [{
  id,
  xpubkey: 'xpub-' + id,
  authXpubkey: 'auth-' + id,
  status: 'ready',
  maxGap: 20,
  createdAt: 1,
  readyAt: 1,
}]);

const seedCtSpendAddress = (address: string, walletId: string, index: number, scanPrivkey: Buffer) =>
  addToAddressTable(mysql, [{
    address, index, walletId, transactions: 0,
    bip32_account: Bip32Account.CTSpend, scan_privkey: scanPrivkey,
  }]);

const insertShieldedOutput = (
  txId: string, index: number, address: string, mode: number,
  recoveryState: string, value: string | null, tokenId: string | null,
  voided = false,
) => mysql.query(
  `INSERT INTO \`tx_output\`
     (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
      \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`mode\`, \`recovery_state\`)
   VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, FALSE, ?, ?, ?)`,
  [txId, index, address, value, tokenId, voided, mode, recoveryState],
);

const insertSatellite = (
  txId: string, index: number,
  { commitment, rangeProof, ephemeralPubkey, assetCommitment = null }:
  { commitment: Buffer; rangeProof: Buffer; ephemeralPubkey: Buffer; assetCommitment?: Buffer | null },
) => mysql.query(
  `INSERT INTO \`shielded_tx_output_data\`
     (\`tx_id\`, \`index\`, \`commitment\`, \`range_proof\`, \`script\`,
      \`ephemeral_pubkey\`, \`asset_commitment\`)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [txId, index, commitment, rangeProof, Buffer.alloc(1), ephemeralPubkey, assetCommitment],
);

const readOutput = async (txId: string, index: number) => {
  const rows = await mysql.query(
    'SELECT `value`, `token_id`, `recovery_state` FROM `tx_output` WHERE `tx_id` = ? AND `index` = ?',
    [txId, index],
  );
  return rows[0];
};

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('shielded db: ownership resolution', () => {
  it('findShieldedAddressOwnership returns ownership for a claimed CTSpend address', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('addr_ct', 'w1', 3, Buffer.alloc(32, 9));

    const owned = await findShieldedAddressOwnership(mysql, 'addr_ct');
    expect(owned).toEqual({ walletId: 'w1', shieldedIndex: 3, scanPrivkey: Buffer.alloc(32, 9) });
  });

  it('returns null for a transparent/unclaimed/unknown address', async () => {
    await seedWallet('w1');
    await addToAddressTable(mysql, [{
      address: 'addr_t', index: 0, walletId: 'w1', transactions: 0, bip32_account: Bip32Account.Legacy,
    }]);

    expect(await findShieldedAddressOwnership(mysql, 'addr_t')).toBeNull();
    expect(await findShieldedAddressOwnership(mysql, 'nope')).toBeNull();
  });

  it('returns null for a CTSpend address missing its wallet or scan key', async () => {
    await seedWallet('w1');
    // Explicit inserts so each row violates exactly one ownership guard.
    await mysql.query(
      `INSERT INTO \`address\`
         (\`address\`, \`index\`, \`wallet_id\`, \`transactions\`, \`seqnum\`, \`bip32_account\`, \`scan_privkey\`, \`catchup_state\`, \`ct_address\`)
       VALUES
         ('ct_nokey',   0, 'w1',  0, 0, ?, NULL, NULL, NULL),
         ('ct_noowner', 1, NULL,  0, 0, ?, ?,    NULL, NULL)`,
      [Bip32Account.CTSpend, Bip32Account.CTSpend, Buffer.alloc(32, 7)],
    );

    // ct_nokey: claimed CTSpend row with no scan key -> excluded by `scan_privkey IS NOT NULL`
    expect(await findShieldedAddressOwnership(mysql, 'ct_nokey')).toBeNull();
    // ct_noowner: CTSpend row with a scan key but unclaimed -> excluded by `wallet_id IS NOT NULL`
    expect(await findShieldedAddressOwnership(mysql, 'ct_noowner')).toBeNull();
  });

  it('findShieldedAddressOwnershipBatch resolves many and skips misses', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('a1', 'w1', 0, Buffer.alloc(32, 1));
    await seedCtSpendAddress('a2', 'w1', 1, Buffer.alloc(32, 2));

    const m = await findShieldedAddressOwnershipBatch(mysql, ['a1', 'a2', 'missing']);
    expect(m.size).toBe(2);
    expect(m.get('a1')!.shieldedIndex).toBe(0);
    expect(m.get('a2')!.scanPrivkey).toEqual(Buffer.alloc(32, 2));
    expect(await findShieldedAddressOwnershipBatch(mysql, [])).toEqual(new Map());
  });
});

describe('shielded db: recovery-state transitions', () => {
  it('markShieldedTxOutputRecovered promotes an unowned output and is idempotent', async () => {
    await insertShieldedOutput('tx1', 0, 'a1', 1, 'unowned', null, null);

    const r1 = await markShieldedTxOutputRecovered(mysql, 'tx1', 0, { value: 1500n, tokenId: '00' });
    expect(r1.affectedRows).toBe(1);
    const row = await readOutput('tx1', 0);
    expect(row.recovery_state).toBe('recovered');
    expect(String(row.value)).toBe('1500');
    expect(row.token_id).toBe('00');

    const r2 = await markShieldedTxOutputRecovered(mysql, 'tx1', 0, { value: 1500n, tokenId: '00' });
    expect(r2.affectedRows).toBe(0);
  });

  it('markShieldedTxOutputRecovered can re-drive a recovery_failed output', async () => {
    await insertShieldedOutput('tx2', 0, 'a1', 2, 'recovery_failed', null, null);

    const r = await markShieldedTxOutputRecovered(mysql, 'tx2', 0, { value: 42n, tokenId: 'ab' });
    expect(r.affectedRows).toBe(1);
    expect((await readOutput('tx2', 0)).recovery_state).toBe('recovered');
  });

  it('markShieldedTxOutputRecoveryFailed flips a non-recovered output but never a recovered one', async () => {
    await insertShieldedOutput('tx3', 0, 'a1', 1, 'unowned', null, null);
    await insertShieldedOutput('tx4', 0, 'a1', 1, 'recovered', '5', '00');

    await markShieldedTxOutputRecoveryFailed(mysql, 'tx3', 0);
    await markShieldedTxOutputRecoveryFailed(mysql, 'tx4', 0);
    expect((await readOutput('tx3', 0)).recovery_state).toBe('recovery_failed');
    expect((await readOutput('tx4', 0)).recovery_state).toBe('recovered'); // guard: recovered untouched
  });
});

describe('shielded db: outputs to recover', () => {
  beforeEach(async () => {
    await seedWallet('w1');
    await seedWallet('w2');
    await seedCtSpendAddress('a1', 'w1', 0, Buffer.alloc(32, 1));
    await seedCtSpendAddress('a2', 'w2', 0, Buffer.alloc(32, 2)); // other wallet
  });

  it('returns all not-yet-recovered outputs (unowned + recovery_failed), joined to keys + satellite bytes', async () => {
    // amount-shielded (mode 1) with a known token id
    await insertShieldedOutput('tx1', 0, 'a1', 1, 'unowned', null, '00');
    await insertSatellite('tx1', 0, {
      commitment: Buffer.alloc(33, 0xa1), rangeProof: Buffer.alloc(8, 0xb1), ephemeralPubkey: Buffer.alloc(33, 0xc1),
    });
    // fully-shielded (mode 2) with an asset commitment, token id null until recovery
    await insertShieldedOutput('tx2', 0, 'a1', 2, 'unowned', null, null);
    await insertSatellite('tx2', 0, {
      commitment: Buffer.alloc(33, 0xa2), rangeProof: Buffer.alloc(8, 0xb2), ephemeralPubkey: Buffer.alloc(33, 0xc2),
      assetCommitment: Buffer.alloc(33, 0xd2),
    });
    // a previously-failed one is re-driven too
    await insertShieldedOutput('tx3', 0, 'a1', 1, 'recovery_failed', null, '00');
    await insertSatellite('tx3', 0, {
      commitment: Buffer.alloc(33, 0xa3), rangeProof: Buffer.alloc(8, 0xb3), ephemeralPubkey: Buffer.alloc(33, 0xc3),
    });

    const outs = await getShieldedOutputsToRecover(mysql, 'w1', 100);
    expect(outs.map((o) => o.txId).sort()).toEqual(['tx1', 'tx2', 'tx3']);

    const byTx = Object.fromEntries(outs.map((o) => [o.txId, o]));
    expect(byTx.tx1).toMatchObject({
      index: 0, address: 'a1', mode: 1, tokenId: '00',
      scanPrivkey: Buffer.alloc(32, 1),
      ephemeralPubkey: Buffer.alloc(33, 0xc1),
      commitment: Buffer.alloc(33, 0xa1),
      assetCommitment: null,
    });
    expect(byTx.tx2).toMatchObject({
      mode: 2, tokenId: null, assetCommitment: Buffer.alloc(33, 0xd2),
    });
  });

  it('excludes recovered, voided, and other-wallet outputs', async () => {
    await insertShieldedOutput('recovered', 0, 'a1', 1, 'recovered', '5', '00');
    await insertSatellite('recovered', 0, { commitment: Buffer.alloc(33), rangeProof: Buffer.alloc(8), ephemeralPubkey: Buffer.alloc(33) });
    await insertShieldedOutput('other', 0, 'a2', 1, 'unowned', null, '00'); // wallet w2
    await insertSatellite('other', 0, { commitment: Buffer.alloc(33, 2), rangeProof: Buffer.alloc(8), ephemeralPubkey: Buffer.alloc(33, 2) });
    // own-wallet (w1), unowned, but VOIDED -> only the `voided = FALSE` filter excludes it
    await insertShieldedOutput('voided', 0, 'a1', 1, 'unowned', null, '00', true);
    await insertSatellite('voided', 0, { commitment: Buffer.alloc(33, 3), rangeProof: Buffer.alloc(8), ephemeralPubkey: Buffer.alloc(33, 3) });

    expect(await getShieldedOutputsToRecover(mysql, 'w1', 100)).toHaveLength(0);
  });

  it('honours the limit and cursors forward with `after`', async () => {
    for (let i = 0; i < 5; i++) {
      await insertShieldedOutput('lim' + i, 0, 'a1', 1, 'unowned', null, '00');
      await insertSatellite('lim' + i, 0, { commitment: Buffer.alloc(33, i), rangeProof: Buffer.alloc(8), ephemeralPubkey: Buffer.alloc(33, i) });
    }
    const first = await getShieldedOutputsToRecover(mysql, 'w1', 3);
    expect(first.map((o) => o.txId)).toEqual(['lim0', 'lim1', 'lim2']);
    const next = await getShieldedOutputsToRecover(mysql, 'w1', 3, { txId: 'lim2', index: 0 });
    expect(next.map((o) => o.txId)).toEqual(['lim3', 'lim4']);
  });

  it('cursors within a single tx_id using the index tie-breaker', async () => {
    // one tx, three outputs at indexes 0/1/2 -> same tx_id, so paging forward must
    // fall back to the `index > ?` branch of the keyset cursor
    for (const idx of [0, 1, 2]) {
      await insertShieldedOutput('multi', idx, 'a1', 1, 'unowned', null, '00');
      await insertSatellite('multi', idx, { commitment: Buffer.alloc(33, idx), rangeProof: Buffer.alloc(8), ephemeralPubkey: Buffer.alloc(33, idx) });
    }
    const first = await getShieldedOutputsToRecover(mysql, 'w1', 2);
    expect(first.map((o) => [o.txId, o.index])).toEqual([['multi', 0], ['multi', 1]]);
    const next = await getShieldedOutputsToRecover(mysql, 'w1', 2, { txId: 'multi', index: 1 });
    expect(next.map((o) => [o.txId, o.index])).toEqual([['multi', 2]]);
  });
});

describe('upsertShieldedAddressOwnership', () => {
  const rows = [
    { index: 0, spendAddress: 'WSpend0', ctAddress: 'ct0', scanPrivkey: Buffer.alloc(32, 1) },
    { index: 1, spendAddress: 'WSpend1', ctAddress: 'ct1', scanPrivkey: Buffer.alloc(32, 2) },
  ];

  it('claims fresh rows with pending catch-up state', async () => {
    await upsertShieldedAddressOwnership(mysql, 'w1', rows);
    const res = await mysql.query(
      'SELECT `address`, `index`, `wallet_id`, `transactions`, `bip32_account`, `catchup_state`, `ct_address`, `scan_privkey` FROM `address` ORDER BY `index`',
    );
    expect(res).toHaveLength(2);
    expect(res[0].wallet_id).toBe('w1');
    expect(Number(res[0].bip32_account)).toBe(2);
    expect(res[0].catchup_state).toBe('pending');
    expect(res[0].ct_address).toBe('ct0');
    expect(Buffer.from(res[0].scan_privkey).equals(Buffer.alloc(32, 1))).toBe(true);
    expect(Number(res[0].transactions)).toBe(0);
  });

  it('claims a daemon observation row without touching its transactions counter', async () => {
    // daemon observation shape: bare row, involvement already counted
    await mysql.query('INSERT INTO `address` (`address`, `transactions`) VALUES (?, 3)', ['WSpend0']);
    await upsertShieldedAddressOwnership(mysql, 'w1', rows);
    const r = (await mysql.query('SELECT * FROM `address` WHERE `address` = ?', ['WSpend0']))[0];
    expect(r.wallet_id).toBe('w1');
    expect(Number(r.transactions)).toBe(3); // preserved — never in the ON DUPLICATE clause
    expect(r.catchup_state).toBe('pending');
  });

  it('does not reset a done catch-up state on re-claim', async () => {
    await upsertShieldedAddressOwnership(mysql, 'w1', rows);
    await mysql.query('UPDATE `address` SET `catchup_state` = ? WHERE `address` = ?', ['done', 'WSpend0']);
    await upsertShieldedAddressOwnership(mysql, 'w1', rows);
    const r = (await mysql.query('SELECT `catchup_state` FROM `address` WHERE `address` = ?', ['WSpend0']))[0];
    expect(r.catchup_state).toBe('done'); // COALESCE keeps it
  });

  it('is a no-op for an empty row list', async () => {
    await upsertShieldedAddressOwnership(mysql, 'w1', []);
    expect(Number((await mysql.query('SELECT COUNT(*) AS c FROM `address`'))[0].c)).toBe(0);
  });
});

describe('getWalletCtSpendAddresses', () => {
  it('returns only the wallet CTSpend addresses, ordered by index', async () => {
    await upsertShieldedAddressOwnership(mysql, 'w1', [
      { index: 1, spendAddress: 'WSpend1', ctAddress: 'ct1', scanPrivkey: Buffer.alloc(32, 2) },
      { index: 0, spendAddress: 'WSpend0', ctAddress: 'ct0', scanPrivkey: Buffer.alloc(32, 1) },
    ]);
    await upsertShieldedAddressOwnership(mysql, 'w2', [
      { index: 0, spendAddress: 'WOther0', ctAddress: 'ctX', scanPrivkey: Buffer.alloc(32, 9) },
    ]);
    // transparent-claimed row of w1 must be excluded
    await mysql.query('INSERT INTO `address` (`address`, `index`, `wallet_id`, `transactions`) VALUES (?, 0, ?, 0)', ['WTransp0', 'w1']);
    expect(await getWalletCtSpendAddresses(mysql, 'w1')).toStrictEqual(['WSpend0', 'WSpend1']);
  });
});

describe('markShieldedCatchupDone', () => {
  it('marks only the wallet CTSpend rows up to maxIndex', async () => {
    await upsertShieldedAddressOwnership(mysql, 'w1', [
      { index: 0, spendAddress: 'WSpend0', ctAddress: 'ct0', scanPrivkey: Buffer.alloc(32, 1) },
      { index: 1, spendAddress: 'WSpend1', ctAddress: 'ct1', scanPrivkey: Buffer.alloc(32, 2) },
      { index: 2, spendAddress: 'WSpend2', ctAddress: 'ct2', scanPrivkey: Buffer.alloc(32, 3) },
    ]);
    await markShieldedCatchupDone(mysql, 'w1', 1);
    const res: DbSelectResult = await mysql.query('SELECT `index`, `catchup_state` FROM `address` ORDER BY `index`');
    expect(res.map((r) => r.catchup_state)).toStrictEqual(['done', 'done', 'pending']);
  });
});

describe('generateShieldedAddresses', () => {
  const bip32lib = BIP32Factory(ecc);
  const gapRoot = bip32lib.fromSeed(Buffer.from('02'.repeat(32), 'hex'));
  const gapScanXpriv = gapRoot.derivePath("m/44'/280'/1'/0").toBase58();
  const gapSpendXpub = gapRoot.derivePath("m/44'/280'/2'/0").neutered().toBase58();
  const gapNetwork = new Network(process.env.NETWORK as string);
  const derivedAt = (i: number) => deriveCtAddress(gapScanXpriv, gapSpendXpub, i, gapNetwork);

  const seedOutputAt = (address: string, txId: string, mode = 1, voided = false) => mysql.query(
    `INSERT INTO \`tx_output\`
       (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
        \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`mode\`, \`recovery_state\`)
     VALUES (?, 0, ?, NULL, NULL, 0, NULL, NULL, FALSE, ?, ?, 'unowned')`,
    [txId, address, voided, mode],
  );

  it('derives exactly maxGap addresses when nothing was ever used', async () => {
    const res = await generateShieldedAddresses(mysql, gapScanXpriv, gapSpendXpub, 5, gapNetwork);
    expect(res.rows).toHaveLength(5);
    expect(res.lastUsedShieldedIndex).toBeNull();
    expect(res.rows[0]).toStrictEqual({
      index: 0,
      spendAddress: derivedAt(0).spendAddress,
      ctAddress: derivedAt(0).ctAddress,
      scanPrivkey: derivedAt(0).scanPrivkey,
    });
    expect(res.addresses).toStrictEqual(res.rows.map((r) => r.spendAddress));
  });

  it('extends the window past chained usage into a later block', async () => {
    // usage at 3 pulls the window to 0..8; usage at 7 (found in the second
    // block) pulls it to 0..12. An isolated use at 7 with 0..6 unused would
    // violate the gap rule itself and is correctly out of reach.
    await seedOutputAt(derivedAt(3).spendAddress, 'gap-tx0');
    await seedOutputAt(derivedAt(7).spendAddress, 'gap-tx1');
    const res = await generateShieldedAddresses(mysql, gapScanXpriv, gapSpendXpub, 5, gapNetwork);
    expect(res.lastUsedShieldedIndex).toBe(7);
    expect(res.rows).toHaveLength(13); // 0..12 = lastUsed + maxGap
    expect(res.rows[12].index).toBe(12);
  });

  it('counts a transparent (mode 0) output to a shielded spend address as usage', async () => {
    await seedOutputAt(derivedAt(2).spendAddress, 'gap-tx2', 0);
    const res = await generateShieldedAddresses(mysql, gapScanXpriv, gapSpendXpub, 5, gapNetwork);
    expect(res.lastUsedShieldedIndex).toBe(2);
    expect(res.rows).toHaveLength(8); // 0..7
  });

  it('ignores voided outputs', async () => {
    await seedOutputAt(derivedAt(3).spendAddress, 'gap-tx3', 1, true);
    const res = await generateShieldedAddresses(mysql, gapScanXpriv, gapSpendXpub, 5, gapNetwork);
    expect(res.lastUsedShieldedIndex).toBeNull();
    expect(res.rows).toHaveLength(5);
  });
});
