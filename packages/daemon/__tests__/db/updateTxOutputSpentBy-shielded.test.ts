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
  updateTxOutputSpentBy,
} from '../../src/db';
import { TxInput } from '@wallet-service/common/src/types';
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
  await mysql.query('DELETE FROM shielded_tx_output_data');
});

const buildInput = (txId: string, index: number): TxInput => ({
  value: 0n,
  token_data: 0,
  script: '',
  decoded: null,
  token: '00',
  tx_id: txId,
  index,
});

describe('updateTxOutputSpentBy is kind-agnostic', () => {
  test('marks a transparent (mode=0) row as spent', async () => {
    expect.hasAssertions();

    const prevTxId = 'PREV_TRANSPARENT';
    const consumingTxId = 'CONSUMER_TX_T';

    await insertTxOutput(mysql, {
      tx_id: prevTxId,
      index: 0,
      mode: ShieldedOutputMode.Transparent,
      address: 'WT4nB',
      value: 100n,
      token_id: '00',
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      voided: false,
      recovery_state: null,
    });

    await updateTxOutputSpentBy(mysql, [buildInput(prevTxId, 0)], consumingTxId);

    const row = await getTxOutput(mysql, prevTxId, 0, false);
    expect(row).not.toBeNull();
    expect(row!.spentBy).toBe(consumingTxId);
    expect(row!.mode).toBe(ShieldedOutputMode.Transparent);
    expect(row!.recoveryState).toBeNull();
  });

  test('marks a shielded recovered (mode=1) row as spent', async () => {
    expect.hasAssertions();

    const prevTxId = 'PREV_SHIELDED_RECOVERED';
    const consumingTxId = 'CONSUMER_TX_S1';

    await insertTxOutput(mysql, {
      tx_id: prevTxId,
      index: 0,
      mode: ShieldedOutputMode.AmountShielded,
      address: 'WT4nB',
      value: 150n,
      token_id: '00',
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      voided: false,
      recovery_state: RecoveryState.Recovered,
    });

    await updateTxOutputSpentBy(mysql, [buildInput(prevTxId, 0)], consumingTxId);

    const row = await getTxOutput(mysql, prevTxId, 0, false);
    expect(row).not.toBeNull();
    expect(row!.spentBy).toBe(consumingTxId);
    expect(row!.mode).toBe(ShieldedOutputMode.AmountShielded);
    expect(row!.recoveryState).toBe(RecoveryState.Recovered);
    expect(row!.value).toBe(150n);
  });

  test('marks a shielded unowned (mode=1) row as spent regardless of recovery state', async () => {
    expect.hasAssertions();

    const prevTxId = 'PREV_SHIELDED_UNOWNED';
    const consumingTxId = 'CONSUMER_TX_S2';

    await insertTxOutput(mysql, {
      tx_id: prevTxId,
      index: 0,
      mode: ShieldedOutputMode.AmountShielded,
      address: 'WT4nB',
      value: null,
      token_id: null,
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      voided: false,
      recovery_state: RecoveryState.Unowned,
    });

    await updateTxOutputSpentBy(mysql, [buildInput(prevTxId, 0)], consumingTxId);

    const row = await getTxOutput(mysql, prevTxId, 0, false);
    expect(row).not.toBeNull();
    expect(row!.spentBy).toBe(consumingTxId);
    expect(row!.mode).toBe(ShieldedOutputMode.AmountShielded);
    expect(row!.recoveryState).toBe(RecoveryState.Unowned);
    expect(row!.value).toBeNull();
  });
});
