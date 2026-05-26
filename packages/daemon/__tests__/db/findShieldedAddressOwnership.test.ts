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
});

describe('findShieldedAddressOwnership', () => {
  test('returns null when no row exists for the address', async () => {
    expect.hasAssertions();

    const result = await findShieldedAddressOwnership(mysql, 'WT4nMISSING');

    expect(result).toBeNull();
  });

  test('returns null when the address exists but ownership / scan_privkey is NULL (unowned)', async () => {
    expect.hasAssertions();

    await upsertShieldedAddressObservation(mysql, 'WT4nUNOWNED');

    const result = await findShieldedAddressOwnership(mysql, 'WT4nUNOWNED');

    expect(result).toBeNull();
  });

  test('returns null when only a Legacy (bip32_account=0) row exists for the address', async () => {
    expect.hasAssertions();

    await mysql.query(
      `INSERT INTO address (address, bip32_account, \`index\`, wallet_id, transactions)
       VALUES (?, 0, 0, 'wallet_alice', 1)`,
      ['WT4nTRANSPARENT'],
    );

    const result = await findShieldedAddressOwnership(mysql, 'WT4nTRANSPARENT');

    expect(result).toBeNull();
  });

  test('returns ownership info when the shielded row has been claimed by a wallet', async () => {
    expect.hasAssertions();

    await upsertShieldedAddressObservation(mysql, 'WT4nOWNED');

    const scanPrivkey = Buffer.alloc(32, 0x42);
    await mysql.query(
      `UPDATE address
         SET wallet_id = ?, \`index\` = ?, scan_privkey = ?
       WHERE address = ? AND bip32_account = 2`,
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
