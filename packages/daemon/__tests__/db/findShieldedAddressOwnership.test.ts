/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Connection } from 'mysql2/promise';
import {
  findShieldedAddressOwnership,
  findShieldedAddressOwnershipBatch,
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

    // Simulate a wallet registration claiming this row: sets wallet_id,
    // derivation slot (bip32_account = 2 = CTSpend), index, and scan key.
    // The observation row started with bip32_account NULL, so the WHERE
    // clause matches the row by address alone.
    const scanPrivkey = Buffer.alloc(32, 0x42);
    await mysql.query(
      `UPDATE address
         SET wallet_id = ?, bip32_account = ?, \`index\` = ?, scan_privkey = ?
       WHERE address = ?`,
      ['wallet_alice', 2, 7, scanPrivkey, 'WT4nOWNED'],
    );

    const result = await findShieldedAddressOwnership(mysql, 'WT4nOWNED');

    expect(result).toMatchObject({
      wallet_id: 'wallet_alice',
      shielded_index: 7,
    });
    expect(result!.scan_privkey.equals(Buffer.alloc(32, 0x42))).toBe(true);
  });
});

describe('findShieldedAddressOwnershipBatch', () => {
  // Promote an observation row to a wallet-claimed CTSpend row (bip32_account = 2),
  // mirroring what a wallet registration does. The void path relies on this exact
  // shape to decide whether a same-address row gets its balance reversed.
  const claimAddress = async (address: string, index: number): Promise<void> => {
    await upsertShieldedAddressObservation(mysql, address);
    await mysql.query(
      `UPDATE address
         SET wallet_id = 'wallet_alice', bip32_account = 2, \`index\` = ?, scan_privkey = ?
       WHERE address = ?`,
      [index, Buffer.alloc(32, 0x42), address],
    );
  };

  test('returns an empty map for an empty address list (early return, no query)', async () => {
    expect.hasAssertions();

    const result = await findShieldedAddressOwnershipBatch(mysql, []);

    expect(result.size).toBe(0);
  });

  test('deduplicates a repeated address into a single map entry', async () => {
    expect.hasAssertions();

    await claimAddress('WT4nOWNED', 7);

    const result = await findShieldedAddressOwnershipBatch(mysql, ['WT4nOWNED', 'WT4nOWNED']);

    expect(result.size).toBe(1);
    expect(result.get('WT4nOWNED')).toMatchObject({
      wallet_id: 'wallet_alice',
      shielded_index: 7,
    });
  });

  test('omits existing-but-unowned rows (NULL scan_privkey / non-CTSpend account)', async () => {
    expect.hasAssertions();

    // Owned CTSpend row — must be present in the map.
    await claimAddress('WT4nOWNED', 7);
    // Observation row that no wallet has claimed: scan_privkey stays NULL.
    await upsertShieldedAddressObservation(mysql, 'WT4nUNOWNED');
    // Legacy (bip32_account = 0) row for an unrelated address.
    await mysql.query(
      `INSERT INTO address (address, bip32_account, \`index\`, wallet_id, transactions)
       VALUES ('WT4nLEGACY', 0, 0, 'wallet_alice', 1)`,
    );

    const result = await findShieldedAddressOwnershipBatch(
      mysql,
      ['WT4nOWNED', 'WT4nUNOWNED', 'WT4nLEGACY'],
    );

    expect(result.size).toBe(1);
    expect(result.has('WT4nOWNED')).toBe(true);
    expect(result.has('WT4nUNOWNED')).toBe(false);
    expect(result.has('WT4nLEGACY')).toBe(false);
  });
});
