/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Connection } from 'mysql2/promise';
import {
  getDbConnection,
  getTxOutput,
  insertTxOutput,
  markTxOutputRecovered,
  markTxOutputRecoveryFailed,
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
  await mysql.query('DELETE FROM shielded_address');
  await mysql.query('DELETE FROM shielded_tx_output_data');
});

describe('markTxOutputRecovered / markTxOutputRecoveryFailed', () => {
  test('markTxOutputRecovered promotes an unowned row to recovered with the decrypted value', async () => {
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

    const result = await markTxOutputRecovered(mysql, 'T1', 0, {
      value: 150n,
      token_id: '00',
    });
    expect(result.affectedRows).toBe(1);

    const row = await getTxOutput(mysql, 'T1', 0, false);
    expect(row).not.toBeNull();
    expect(row!.value).toBe(150n);
    expect(row!.recoveryState).toBe('recovered');
  });

  test('markTxOutputRecovered is idempotent — second call is a no-op and does not overwrite', async () => {
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

    const first = await markTxOutputRecovered(mysql, 'T1', 0, {
      value: 150n,
      token_id: '00',
    });
    expect(first.affectedRows).toBe(1);

    const second = await markTxOutputRecovered(mysql, 'T1', 0, {
      value: 999n,
      token_id: '00',
    });
    expect(second.affectedRows).toBe(0);

    const row = await getTxOutput(mysql, 'T1', 0, false);
    expect(row).not.toBeNull();
    expect(row!.value).toBe(150n);
    expect(row!.recoveryState).toBe('recovered');
  });

  test('markTxOutputRecoveryFailed flips recovery_state to recovery_failed and leaves value null', async () => {
    expect.hasAssertions();

    await insertTxOutput(mysql, {
      tx_id: 'T2',
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

    await markTxOutputRecoveryFailed(mysql, 'T2', 0);

    const row = await getTxOutput(mysql, 'T2', 0, false);
    expect(row).not.toBeNull();
    expect(row!.value).toBeNull();
    expect(row!.recoveryState).toBe('recovery_failed');
  });
});
