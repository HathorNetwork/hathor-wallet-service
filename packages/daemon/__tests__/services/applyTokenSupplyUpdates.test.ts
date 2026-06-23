/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Pure-arithmetic unit tests for applyTokenSupplyUpdates. The DB writer
 * (incrementTokenTotalSupply) is mocked, so these tests assert only the
 * mint/melt/block-reward delta computation with no DB interaction.
 */

import hathorLib from '@hathor/wallet-lib';
import { TxInput, TxOutputWithIndex } from '@wallet-service/common';

jest.mock('../../src/db');

// eslint-disable-next-line import/first
import { applyTokenSupplyUpdates } from '../../src/services';
// eslint-disable-next-line import/first
import { incrementTokenTotalSupply } from '../../src/db';

const mockIncrement = incrementTokenTotalSupply as jest.Mock;

const TX_VERSION = 1; // any non-block version
const BLOCK_VERSION = hathorLib.constants.BLOCK_VERSION;

const output = (token: string, value: bigint, address = 'H1'): TxOutputWithIndex => ({
  value,
  token,
  token_data: 0,
  script: '',
  spent_by: null,
  index: 0,
  decoded: { type: 'P2PKH', address, timelock: null },
}) as unknown as TxOutputWithIndex;

const input = (token: string, value: bigint): TxInput => ({
  tx_id: 't',
  index: 0,
  value,
  token,
  token_data: 0,
  script: '',
  decoded: null,
}) as unknown as TxInput;

const mysql = {} as any;

beforeEach(() => {
  mockIncrement.mockClear();
});

describe('applyTokenSupplyUpdates', () => {
  it('applies one signed delta per token for a multi-token tx', async () => {
    // token A: 100 out - 0 in = +100; token B: 50 out - 20 in = +30.
    await applyTokenSupplyUpdates(
      mysql,
      TX_VERSION,
      [output('A', 100n), output('B', 50n)],
      [input('B', 20n)],
      0,
    );

    expect(mockIncrement).toHaveBeenCalledTimes(2);
    expect(mockIncrement).toHaveBeenCalledWith(mysql, 'A', 100n);
    expect(mockIncrement).toHaveBeenCalledWith(mysql, 'B', 30n);
  });

  it('does not write when the per-token delta is zero', async () => {
    await applyTokenSupplyUpdates(
      mysql,
      TX_VERSION,
      [output('A', 100n)],
      [input('A', 100n)],
      0,
    );

    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('does not write a block whose summed reward is zero', async () => {
    await applyTokenSupplyUpdates(
      mysql,
      BLOCK_VERSION,
      [output(hathorLib.constants.NATIVE_TOKEN_UID, 0n)],
      [],
      0,
    );

    expect(mockIncrement).not.toHaveBeenCalled();
  });
});
