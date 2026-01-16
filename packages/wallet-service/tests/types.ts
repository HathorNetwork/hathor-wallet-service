/* eslint-disable max-classes-per-file */

/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { TokenVersion } from '@hathor/wallet-lib';

export interface WalletBalanceEntry {
  walletId: string;
  tokenId: string;
  unlockedBalance: bigint;
  lockedBalance: bigint;
  unlockedAuthorities: number;
  lockedAuthorities: number;
  timelockExpires?: number;
  transactions: number;
}

export interface AddressTxHistoryTableEntry {
  address: string;
  txId: string;
  tokenId: string;
  balance: bigint;
  timestamp: number;
  voided?: boolean;
}

export interface AddressTableEntry {
  address: string;
  index: number;
  walletId?: string;
  transactions: number;
  seqnum?: number;
}

export interface TokenTableEntry {
  id: string;
  name: string;
  symbol: string;
  version: TokenVersion;
  transactions: number;
}

export interface WalletTableEntry {
  id: string;
  xpubkey: string;
  authXpubkey: string;
  status: string;
  maxGap: number;
  highestUsedIndex?: number;
  createdAt: number;
  readyAt: number;
}
