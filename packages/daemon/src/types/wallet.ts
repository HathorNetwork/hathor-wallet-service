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
  // Gross shielded amount RECEIVED in this tx for this token: the sum of the
  // positive (recovered) shielded receipts, suppressed to 0 on a pure spend.
  // Always >= 0 — NOT a net delta. The push builder gates on `shieldedAmount > 0`
  // and adds it to the displayed amount, so it must never carry a negative value
  // (a "net" reading would emit -value on spends and break the gate). `total`
  // stays transparent-only; the push builder combines the two.
  shieldedAmount: bigint;
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
