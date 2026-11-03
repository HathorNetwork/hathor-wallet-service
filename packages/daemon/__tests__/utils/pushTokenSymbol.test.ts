/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { constants } from '@hathor/wallet-lib';
import { Transaction, TokenBalanceMap } from '@wallet-service/common';
import { StringMap, Wallet, WalletStatus } from '../../src/types';
import {
  getWalletBalancesForTx,
  FromTokenBalanceMapToBalanceValueList,
  unknownTokenSymbol,
} from '../../src/utils';
import { getAddressWalletInfo, getTokenSymbols } from '../../src/db';
import logger from '../../src/logger';

jest.mock('../../src/db', () => ({
  ...jest.requireActual('../../src/db'),
  getAddressWalletInfo: jest.fn(),
  getTokenSymbols: jest.fn(),
}));

jest.mock('../../src/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

/**
 * @jest-environment node
 */

const NEW_TOKEN_UID = '00000442b418688c5379b2c28ac36b075ab47faea0610714ca18b29951ca40a1';

const wallets: StringMap<Wallet> = {
  addr1: {
    walletId: 'w1', xpubkey: 'xpub', authXpubkey: 'auth', maxGap: 20, status: WalletStatus.READY, ctStatus: 'none',
  },
};

const tokenCreationTx = {
  tx_id: NEW_TOKEN_UID,
  version: 2,
  token_name: 'Haven',
  token_symbol: 'HVN',
} as unknown as Transaction;

// The creator receives the new token and pays the HTR deposit.
const creatorBalances = (): StringMap<TokenBalanceMap> => ({
  addr1: TokenBalanceMap.fromStringMap({
    [NEW_TOKEN_UID]: { unlocked: 1000n, locked: 0n },
    [constants.NATIVE_TOKEN_UID]: { unlocked: -10n, locked: 0n },
  }),
});

const symbolsOf = (result: Awaited<ReturnType<typeof getWalletBalancesForTx>>): StringMap<string> => (
  Object.fromEntries(result.w1.walletBalanceForTx.map((balance) => [balance.tokenId, balance.tokenSymbol]))
);

describe('getWalletBalancesForTx token symbols', () => {
  const mysql = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    (getAddressWalletInfo as jest.Mock).mockResolvedValue(wallets);
  });

  it('uses the tx symbol for the token it creates, before TOKEN_CREATED stores it', async () => {
    (getTokenSymbols as jest.Mock).mockResolvedValue({ [constants.NATIVE_TOKEN_UID]: 'HTR' });

    const result = await getWalletBalancesForTx(mysql, tokenCreationTx, creatorBalances());

    expect(symbolsOf(result)).toEqual({ [NEW_TOKEN_UID]: 'HVN', [constants.NATIVE_TOKEN_UID]: 'HTR' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the stored symbol when the token is already in the token table', async () => {
    (getTokenSymbols as jest.Mock).mockResolvedValue({
      [NEW_TOKEN_UID]: 'STORED',
      [constants.NATIVE_TOKEN_UID]: 'HTR',
    });

    const result = await getWalletBalancesForTx(mysql, tokenCreationTx, creatorBalances());

    expect(symbolsOf(result)[NEW_TOKEN_UID]).toBe('STORED');
  });

  it('falls back to a placeholder when a symbol cannot be resolved', async () => {
    (getTokenSymbols as jest.Mock).mockResolvedValue({ [constants.NATIVE_TOKEN_UID]: 'HTR' });
    const regularTx = { tx_id: 'other-tx', version: 1, token_symbol: null } as unknown as Transaction;

    const result = await getWalletBalancesForTx(mysql, regularTx, creatorBalances());

    expect(symbolsOf(result)[NEW_TOKEN_UID]).toBe(unknownTokenSymbol(NEW_TOKEN_UID));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('FromTokenBalanceMapToBalanceValueList.convert', () => {
  it('never leaves tokenSymbol undefined', () => {
    const balances = TokenBalanceMap.fromStringMap({ [NEW_TOKEN_UID]: { unlocked: 1n, locked: 0n } });

    const [value] = FromTokenBalanceMapToBalanceValueList.convert(balances, {});

    expect(value.tokenSymbol).toBe('51ca40a1');
  });
});
