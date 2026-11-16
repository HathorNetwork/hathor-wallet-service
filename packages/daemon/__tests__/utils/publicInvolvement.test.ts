/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ShieldedOutputMode } from '@wallet-service/common';
import {
  FULLY_SHIELDED_TOKEN_ID,
  PublicInvolvement,
  PublicIo,
  getPublicInvolvement,
  getUnifiedBalanceMap,
  getVertexPublicInvolvement,
  prepareInputs,
  prepareOutputs,
} from '../../src/utils';
import { EventTxHeader, EventTxInput, EventTxOutput } from '../../src/types';
import logger from '../../src/logger';

const TX = 'aa'.repeat(32);
const T1 = '01'.repeat(32);
const T2 = '02'.repeat(32);
const A = 'WAddressAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'WAddressBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'WAddressCCCCCCCCCCCCCCCCCCCCCCCCCC';
const OVER = `W${'x'.repeat(34)}`;
const SCRIPT = 'dqkU91U6sMdzgT3zxOtdIVGbqobP0FmIrA==';
const AUTHORITY_MINT = 0b01;
const AUTHORITY_MELT = 0b10;

const transparent = (address: string, tokenId: string, value: bigint, authorities = 0): PublicIo => ({
  mode: ShieldedOutputMode.Transparent, address, tokenId, value, authorities,
});
const amount = (address: string, tokenId: string | null): PublicIo => ({
  mode: ShieldedOutputMode.AmountShielded, address, tokenId,
});
const fully = (address: string): PublicIo => ({ mode: ShieldedOutputMode.FullyShielded, address });

const sorted = (entries: PublicInvolvement[]) => [...entries].sort((x, y) => (
  `${x.address}:${x.tokenId}`.localeCompare(`${y.address}:${y.tokenId}`)
));
const entry = (address: string, tokenId: string, balance: bigint, hasShielded: boolean): PublicInvolvement => ({
  address, tokenId, balance, hasShielded,
});

const nanoHeader = (address: string): EventTxHeader => ({
  id: '10',
  nc_seqnum: 1,
  nc_id: 'bb'.repeat(32),
  nc_method: 'initialize',
  nc_args: '',
  nc_address: address,
  nc_context: { actions: [], caller_id: address, timestamp: 0 },
} as unknown as EventTxHeader);

describe('getPublicInvolvement', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('adds a transparent output and subtracts a transparent input under their tokens', () => {
    const result = getPublicInvolvement(
      TX,
      [transparent(A, '00', 100n), transparent(B, T1, 7n)],
      [transparent(A, '00', 30n), transparent(C, T1, 7n)],
      [],
    );
    expect(sorted(result)).toEqual(sorted([
      entry(A, '00', 70n, false),
      entry(B, T1, 7n, false),
      entry(C, T1, -7n, false),
    ]));
  });

  it('counts authority outputs and inputs with no balance', () => {
    const result = getPublicInvolvement(
      TX,
      [transparent(A, T1, 0n, AUTHORITY_MINT), transparent(A, T1, 5n)],
      [transparent(B, T1, 0n, AUTHORITY_MELT)],
      [],
    );
    expect(sorted(result)).toEqual(sorted([
      entry(A, T1, 5n, false),
      entry(B, T1, 0n, false),
    ]));
  });

  it('ignores the value of an authority even if one is given', () => {
    const result = getPublicInvolvement(TX, [transparent(A, T1, 99n, AUTHORITY_MINT)], [], []);
    expect(result).toEqual([entry(A, T1, 0n, false)]);
  });

  it('counts an AmountShielded output under its token with no balance', () => {
    expect(getPublicInvolvement(TX, [amount(A, T1)], [], [])).toEqual([entry(A, T1, 0n, true)]);
  });

  it('counts an AmountShielded input under the spent row\'s token with no balance', () => {
    expect(getPublicInvolvement(TX, [], [amount(A, T1)], [])).toEqual([entry(A, T1, 0n, true)]);
  });

  it('counts FullyShielded outputs and inputs under the sentinel only', () => {
    const result = getPublicInvolvement(TX, [fully(A)], [fully(A), fully(B)], []);
    expect(sorted(result)).toEqual(sorted([
      entry(A, FULLY_SHIELDED_TOKEN_ID, 0n, true),
      entry(B, FULLY_SHIELDED_TOKEN_ID, 0n, true),
    ]));
  });

  it('mixes transparent and shielded involvement in one token into one row', () => {
    const result = getPublicInvolvement(
      TX,
      [transparent(A, T1, 50n), amount(A, T1)],
      [transparent(A, T1, 20n)],
      [],
    );
    expect(result).toEqual([entry(A, T1, 30n, true)]);
  });

  it('keeps HTR, a custom token and the sentinel apart for one address', () => {
    const result = getPublicInvolvement(
      TX,
      [transparent(A, '00', 1n), amount(A, T1), fully(A)],
      [],
      [],
    );
    expect(sorted(result)).toEqual(sorted([
      entry(A, '00', 1n, false),
      entry(A, T1, 0n, true),
      entry(A, FULLY_SHIELDED_TOKEN_ID, 0n, true),
    ]));
  });

  it('records an AmountShielded output or input with an unknown token under the sentinel and warns', () => {
    const result = getPublicInvolvement(TX, [amount(A, null)], [amount(B, null)], []);
    expect(sorted(result)).toEqual(sorted([
      entry(A, FULLY_SHIELDED_TOKEN_ID, 0n, true),
      entry(B, FULLY_SHIELDED_TOKEN_ID, 0n, true),
    ]));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('gives a nano caller with no other entry an HTR row with no balance', () => {
    expect(getPublicInvolvement(TX, [], [], [A])).toEqual([entry(A, '00', 0n, false)]);
  });

  it('does not give a nano caller an HTR row when it is involved in another token', () => {
    const result = getPublicInvolvement(TX, [transparent(A, T1, 3n)], [], [A]);
    expect(result).toEqual([entry(A, T1, 3n, false)]);
  });

  it('does not give a nano caller an HTR row when its only involvement is FullyShielded', () => {
    const result = getPublicInvolvement(TX, [fully(A)], [], [A]);
    expect(result).toEqual([entry(A, FULLY_SHIELDED_TOKEN_ID, 0n, true)]);
  });

  it('keeps a nano caller\'s transparent HTR row as it is', () => {
    const result = getPublicInvolvement(TX, [transparent(A, '00', 4n)], [], [A]);
    expect(result).toEqual([entry(A, '00', 4n, false)]);
  });

  it('adds one HTR row for a nano caller listed twice', () => {
    expect(getPublicInvolvement(TX, [], [], [A, A])).toEqual([entry(A, '00', 0n, false)]);
  });

  it('drops an over-length address from every source and logs it', () => {
    const result = getPublicInvolvement(
      TX,
      [transparent(OVER, '00', 1n), amount(OVER, T1), fully(OVER), transparent(A, '00', 1n)],
      [transparent(OVER, '00', 1n), fully(OVER)],
      [OVER],
    );
    expect(result).toEqual([entry(A, '00', 1n, false)]);
    expect(error).toHaveBeenCalled();
  });

  it('returns nothing for a vertex with no public involvement', () => {
    expect(getPublicInvolvement(TX, [], [], [])).toEqual([]);
  });
});

describe('getVertexPublicInvolvement', () => {
  const out = (value: bigint, address: string, tokenData = 0, timelock: number | null = null): EventTxOutput => ({
    value, script: SCRIPT, token_data: tokenData, locked: false, decoded: { type: 'P2PKH', address, timelock },
  } as unknown as EventTxOutput);
  const undecodedOut = (value: bigint): EventTxOutput => ({
    value, script: SCRIPT, token_data: 0, locked: false, decoded: null,
  } as unknown as EventTxOutput);
  const inp = (value: bigint, address: string | null, tokenData = 0, index = 0): EventTxInput => ({
    tx_id: 'cc'.repeat(32),
    index,
    spent_output: {
      mode: 0,
      value,
      script: SCRIPT,
      token_data: tokenData,
      locked: false,
      decoded: address ? { type: 'P2PKH', address, timelock: null } : null,
    },
  } as unknown as EventTxInput);
  const tokens = [T1, T2];

  it('derives transparent entries from the prepared outputs and inputs', () => {
    const txOutputs = prepareOutputs([
      out(100n, A),
      out(5n, B, 1),
      out(AUTHORITY_MINT as unknown as bigint, B, 0x81),
      undecodedOut(9n),
    ], tokens);
    const txInputs = prepareInputs([inp(40n, A), inp(2n, C, 2), inp(1n, null)], tokens);

    const result = getVertexPublicInvolvement(TX, txOutputs, txInputs, [], [], []);
    expect(sorted(result)).toEqual(sorted([
      entry(A, '00', 60n, false),
      entry(B, T1, 5n, false),
      entry(C, T2, -2n, false),
    ]));
  });

  it('adds the stored shielded outputs, the spent shielded rows and the nano callers', () => {
    const result = getVertexPublicInvolvement(
      TX,
      [],
      [],
      [
        { mode: ShieldedOutputMode.AmountShielded, address: A, tokenId: T1 },
        { mode: ShieldedOutputMode.FullyShielded, address: B },
      ],
      [
        { txId: 'dd'.repeat(32), index: 2, mode: ShieldedOutputMode.AmountShielded, address: C, tokenId: T2 },
        // A FullyShielded row's token is never read, even when it holds one.
        { txId: 'dd'.repeat(32), index: 3, mode: ShieldedOutputMode.FullyShielded, address: C, tokenId: T1 },
        // A transparent row is not a shielded input; it contributes nothing.
        { txId: 'dd'.repeat(32), index: 0, mode: ShieldedOutputMode.Transparent, address: C, tokenId: '00' },
      ],
      [nanoHeader(A), nanoHeader('WNanoOnlyCallerAAAAAAAAAAAAAAAAAAA'), { id: '11' } as EventTxHeader],
    );
    expect(sorted(result)).toEqual(sorted([
      entry(A, T1, 0n, true),
      entry(B, FULLY_SHIELDED_TOKEN_ID, 0n, true),
      entry(C, T2, 0n, true),
      entry(C, FULLY_SHIELDED_TOKEN_ID, 0n, true),
      entry('WNanoOnlyCallerAAAAAAAAAAAAAAAAAAA', '00', 0n, false),
    ]));
  });

  it('matches address_tx_history balances for a transparent-only vertex', async () => {
    const outputs = [
      out(100n, A),
      out(50n, A, 0, 4102444800), // timelocked, so it lands in the locked column
      out(5n, B, 1),
      out(AUTHORITY_MINT as unknown as bigint, B, 0x81),
      out(AUTHORITY_MELT as unknown as bigint, C, 0x82),
      out(8n, C, 2),
    ];
    const inputs = [
      inp(40n, A, 0, 0),
      inp(2n, C, 2, 1),
      inp(AUTHORITY_MINT as unknown as bigint, A, 0x81, 2),
      inp(13n, B, 0, 3),
    ];
    const txOutputs = prepareOutputs(outputs, tokens);
    // As markLockedOutputs would with a future timelock.
    for (const o of txOutputs) o.locked = (o.decoded?.timelock ?? 0) > 0;
    const txInputs = prepareInputs(inputs, tokens);

    // No shielded inputs, so the balance map never queries the database.
    const map = await getUnifiedBalanceMap({} as never, txInputs, txOutputs, [], inputs, []);
    const expected: PublicInvolvement[] = [];
    for (const [address, tokenMap] of Object.entries(map)) {
      for (const [token, balance] of tokenMap.iterator()) {
        expected.push(entry(address, token, balance.unlockedAmount + balance.lockedAmount, false));
      }
    }

    const result = getVertexPublicInvolvement(TX, txOutputs, txInputs, [], [], []);
    expect(sorted(result)).toEqual(sorted(expected));
    expect(result).toHaveLength(5);
  });
});
