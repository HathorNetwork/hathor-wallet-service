/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Connection } from 'mysql2/promise';
import {
  getDbConnection,
  upsertShieldedAddressObservation,
} from '../../src/db';
import { cleanDatabase } from '../utils';

let mysql: Connection;

beforeAll(async () => {
  try {
    mysql = await getDbConnection();
  } catch (e) {
    console.error('Failed to establish db connection', e);
    throw e;
  }
});

afterAll(() => {
  mysql.destroy();
});

beforeEach(async () => {
  await cleanDatabase(mysql);
  // `shielded_address` is not yet part of the shared cleanDatabase TABLES list;
  // wipe it manually to keep these tests isolated.
  await mysql.query('DELETE FROM shielded_address');
});

interface ShieldedAddressRow {
  address: string;
  wallet_id: string | null;
  shielded_index: number | null;
  shielded_address: string | null;
  scan_privkey: Buffer | null;
  catchup_state: 'pending' | 'running' | 'done' | null;
  transactions: number;
  created_at: Date;
}

describe('upsertShieldedAddressObservation', () => {
  test('first observation inserts a row with NULL ownership and transactions=1', async () => {
    expect.hasAssertions();

    await upsertShieldedAddressObservation(mysql, 'WT4nNEW');

    const [rows] = await mysql.execute(
      'SELECT * FROM shielded_address WHERE address = ?',
      ['WT4nNEW'],
    );
    const result = rows as ShieldedAddressRow[];

    expect(result).toHaveLength(1);
    const row = result[0];
    expect(row.address).toBe('WT4nNEW');
    expect(row.wallet_id).toBeNull();
    expect(row.shielded_index).toBeNull();
    expect(row.shielded_address).toBeNull();
    expect(row.scan_privkey).toBeNull();
    expect(row.catchup_state).toBeNull();
    expect(row.transactions).toBe(1);
    expect(row.created_at).toBeInstanceOf(Date);
  });

  test('second observation increments transactions while preserving ownership fields', async () => {
    expect.hasAssertions();

    await upsertShieldedAddressObservation(mysql, 'WT4nEXIST');

    const scanPrivkey = Buffer.alloc(32, 0x42);
    await mysql.query(
      `UPDATE shielded_address
         SET wallet_id = ?, scan_privkey = ?, shielded_index = ?
       WHERE address = ?`,
      ['wallet_alice', scanPrivkey, 7, 'WT4nEXIST'],
    );

    await upsertShieldedAddressObservation(mysql, 'WT4nEXIST');

    const [rows] = await mysql.execute(
      'SELECT * FROM shielded_address WHERE address = ?',
      ['WT4nEXIST'],
    );
    const result = rows as ShieldedAddressRow[];

    expect(result).toHaveLength(1);
    const row = result[0];
    expect(row.transactions).toBe(2);
    expect(row.wallet_id).toBe('wallet_alice');
    expect(row.shielded_index).toBe(7);
    expect(row.scan_privkey).not.toBeNull();
    expect(row.scan_privkey!.equals(scanPrivkey)).toBe(true);
  });
});
