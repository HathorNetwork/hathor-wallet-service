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

describe('insertTxOutput', () => {
  test('writes a transparent row with mode=0 and recovery_state=NULL', async () => {
    expect.hasAssertions();

    await insertTxOutput(mysql, {
      tx_id: 'T0',
      index: 0,
      mode: ShieldedOutputMode.Transparent,
      address: 'WT4nA',
      value: 100n,
      token_id: '00',
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      voided: false,
      recovery_state: null,
    });

    const row = await getTxOutput(mysql, 'T0', 0, false);
    expect(row).not.toBeNull();
    expect(row!.mode).toBe(0);
    expect(row!.recoveryState).toBeNull();
    expect(row!.value).toBe(100n);
    expect(row!.tokenId).toBe('00');
  });

  test('writes an unrecovered AmountShielded row with value NULL but token_id populated', async () => {
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

    const row = await getTxOutput(mysql, 'T1', 0, false);
    expect(row).not.toBeNull();
    expect(row!.mode).toBe(1);
    expect(row!.value).toBeNull();
    expect(row!.tokenId).toBe('00');
    expect(row!.recoveryState).toBe('unowned');
  });

  test('writes an unrecovered FullyShielded row with both value and token_id NULL', async () => {
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

    const row = await getTxOutput(mysql, 'T2', 0, false);
    expect(row).not.toBeNull();
    expect(row!.mode).toBe(2);
    expect(row!.value).toBeNull();
    expect(row!.tokenId).toBeNull();
    expect(row!.recoveryState).toBe('unowned');
  });
});
