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
  unlockedShieldedBalance?: bigint;
  lockedShieldedBalance?: bigint;
  totalShieldedReceived?: bigint;
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
  // Hathor BIP32 account slot. Stored values: 0 = Legacy (m/44'/280'/0'),
  // 2 = CTSpend (m/44'/280'/2'). Account 1 = CTScan is reserved for the
  // scan-key derivation and never stored as a row identifier. Required so
  // tests are explicit about which slot they're seeding; the unique
  // constraint on (wallet_id, bip32_account, index) enforces strictly.
  bip32_account: number;
  // CTSpend-only fields. Set on bip32_account = 2 rows that represent an
  // owned CTSpend slot; left undefined / NULL on Legacy rows.
  scan_privkey?: Buffer;
  catchup_state?: 'pending' | 'running' | 'done';
  ct_address?: string;
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
  ctStatus?: string;
}
