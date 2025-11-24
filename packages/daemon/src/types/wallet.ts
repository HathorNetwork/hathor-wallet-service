/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { TokenBalanceMap } from '@wallet-service/common';

export enum WalletStatus {
  CREATING = 'creating',
  READY = 'ready',
  ERROR = 'error',
}

export interface Wallet {
  walletId: string;
  xpubkey: string;
  authXpubkey: string,
  maxGap: number;
  status?: WalletStatus;
  retryCount?: number;
  createdAt?: number;
  readyAt?: number;
}

export type TokenBalanceValue = {
  tokenId: string,
  tokenSymbol: string,
  totalAmountSent: bigint;
  lockedAmount: bigint;
  unlockedAmount: bigint;
  lockedAuthorities: Record<string, unknown>;
  unlockedAuthorities: Record<string, unknown>;
  lockExpires: number | null;
  total: bigint;
}

export interface WalletBalanceValue {
  txId: string,
  walletId: string,
  addresses: string[],
  walletBalanceForTx: TokenBalanceValue[],
}

export interface WalletBalance {
  txId: string,
  walletId: string,
  addresses: string[],
  walletBalanceForTx: TokenBalanceMap,
}
