/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ServerlessMysql } from 'serverless-mysql';
import { Bip32Account } from '@wallet-service/common';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase, addToWalletTable, addToAddressTable } from '@tests/utils';
import {
  findShieldedAddressOwnership,
  findShieldedAddressOwnershipBatch,
  markShieldedTxOutputRecovered,
  markShieldedTxOutputRecoveryFailed,
  getShieldedOutputsToRecover,
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
) => mysql.query(
  `INSERT INTO \`tx_output\`
     (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
      \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`mode\`, \`recovery_state\`)
   VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, FALSE, FALSE, ?, ?)`,
  [txId, index, address, value, tokenId, mode, recoveryState],
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
});
