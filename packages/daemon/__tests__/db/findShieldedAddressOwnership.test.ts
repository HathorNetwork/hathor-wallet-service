/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Connection } from 'mysql2/promise';
import {
  findShieldedAddressOwnership,
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

describe('findShieldedAddressOwnership', () => {
  test('returns null when no row exists for the address', async () => {
    expect.hasAssertions();

    const result = await findShieldedAddressOwnership(mysql, 'WT4nMISSING');

    expect(result).toBeNull();
  });

  test('returns null when the address exists but ownership is NULL (unowned)', async () => {
    expect.hasAssertions();

    await upsertShieldedAddressObservation(mysql, 'WT4nUNOWNED');

    const result = await findShieldedAddressOwnership(mysql, 'WT4nUNOWNED');

    expect(result).toBeNull();
  });

  test('returns ownership info when the address has been claimed by a wallet', async () => {
    expect.hasAssertions();

    await upsertShieldedAddressObservation(mysql, 'WT4nOWNED');

    const scanPrivkey = Buffer.alloc(32, 0x42);
    await mysql.query(
      `UPDATE shielded_address
         SET wallet_id = ?, shielded_index = ?, scan_privkey = ?
       WHERE address = ?`,
      ['wallet_alice', 7, scanPrivkey, 'WT4nOWNED'],
    );

    const result = await findShieldedAddressOwnership(mysql, 'WT4nOWNED');

    expect(result).toMatchObject({
      wallet_id: 'wallet_alice',
      shielded_index: 7,
    });
    expect(result!.scan_privkey.equals(Buffer.alloc(32, 0x42))).toBe(true);
  });
});
