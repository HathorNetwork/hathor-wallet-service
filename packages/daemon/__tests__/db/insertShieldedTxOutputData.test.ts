/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Connection } from 'mysql2/promise';
import {
  getDbConnection,
  insertShieldedTxOutputData,
  insertTxOutput,
} from '../../src/db';
import { cleanDatabase } from '../utils';
import { ShieldedOutputMode, RecoveryState } from '@wallet-service/common';

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

describe('insertShieldedTxOutputData', () => {
  test('writes an AmountShielded satellite row (mode=1: token_data set, asset_* NULL)', async () => {
    expect.hasAssertions();

    await insertTxOutput(mysql, {
      tx_id: 'T1',
      index: 0,
      mode: ShieldedOutputMode.AmountShielded,
      address: 'WT4nB',
      value: null,
      token_id: '00',
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      voided: false,
      recovery_state: RecoveryState.Unowned,
    });

    await insertShieldedTxOutputData(mysql, {
      tx_id: 'T1',
      output_index: 0,
      mode: 1,
      commitment: Buffer.alloc(33, 0xaa),
      range_proof: Buffer.alloc(64, 0xbb),
      script: Buffer.alloc(20, 0xcc),
      ephemeral_pubkey: Buffer.alloc(33, 0xdd),
      token_data: 1,
    });

    const [rows] = await mysql.execute(
      'SELECT * FROM shielded_tx_output_data WHERE tx_id = ? AND output_index = ?',
      ['T1', 0],
    );
    const result = rows as Array<{
      tx_id: string;
      output_index: number;
      commitment: Buffer;
      range_proof: Buffer;
      script: Buffer;
      ephemeral_pubkey: Buffer;
      token_data: number | null;
      asset_commitment: Buffer | null;
      surjection_proof: Buffer | null;
    }>;

    expect(result).toHaveLength(1);
    const row = result[0];
    expect(row.commitment.equals(Buffer.alloc(33, 0xaa))).toBe(true);
    expect(row.range_proof.equals(Buffer.alloc(64, 0xbb))).toBe(true);
    expect(row.script.equals(Buffer.alloc(20, 0xcc))).toBe(true);
    expect(row.ephemeral_pubkey.equals(Buffer.alloc(33, 0xdd))).toBe(true);
    expect(row.token_data).toBe(1);
    expect(row.asset_commitment).toBeNull();
    expect(row.surjection_proof).toBeNull();
  });

  test('writes a FullyShielded satellite row (mode=2: asset_commitment + surjection_proof set, token_data NULL)', async () => {
    expect.hasAssertions();

    await insertTxOutput(mysql, {
      tx_id: 'T2',
      index: 0,
      mode: ShieldedOutputMode.FullyShielded,
      address: 'WT4nC',
      value: null,
      token_id: null,
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      voided: false,
      recovery_state: RecoveryState.Unowned,
    });

    await insertShieldedTxOutputData(mysql, {
      tx_id: 'T2',
      output_index: 0,
      mode: 2,
      commitment: Buffer.alloc(33, 0xaa),
      range_proof: Buffer.alloc(64, 0xbb),
      script: Buffer.alloc(20, 0xcc),
      ephemeral_pubkey: Buffer.alloc(33, 0xdd),
      asset_commitment: Buffer.alloc(33, 0xee),
      surjection_proof: Buffer.alloc(64, 0xff),
    });

    const [rows] = await mysql.execute(
      'SELECT * FROM shielded_tx_output_data WHERE tx_id = ? AND output_index = ?',
      ['T2', 0],
    );
    const result = rows as Array<{
      tx_id: string;
      output_index: number;
      commitment: Buffer;
      range_proof: Buffer;
      script: Buffer;
      ephemeral_pubkey: Buffer;
      token_data: number | null;
      asset_commitment: Buffer | null;
      surjection_proof: Buffer | null;
    }>;

    expect(result).toHaveLength(1);
    const row = result[0];
    expect(row.commitment.equals(Buffer.alloc(33, 0xaa))).toBe(true);
    expect(row.token_data).toBeNull();
    expect(row.asset_commitment).not.toBeNull();
    expect(row.asset_commitment!.equals(Buffer.alloc(33, 0xee))).toBe(true);
    expect(row.surjection_proof).not.toBeNull();
    expect(row.surjection_proof!.equals(Buffer.alloc(64, 0xff))).toBe(true);
  });
});
