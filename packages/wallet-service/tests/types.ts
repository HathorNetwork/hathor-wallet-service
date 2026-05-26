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
  // Hathor BIP32 account: 0 = transparent (m/44'/280'/0'), 1 = shielded scan
  // path (m/44'/180'/1'). Required to make tests explicit about which slot
  // they're seeding; the unique constraint on (wallet_id, bip32_account, index)
  // rejects collisions, so leaving it implicit was masking impossible fixtures.
  bip32_account: number;
  // Shielded-only fields. Set on bip32_account = 1 rows that represent an owned
  // shielded scan-path slot; left undefined / NULL on transparent rows.
  scan_privkey?: Buffer;
  catchup_state?: 'pending' | 'running' | 'done';
  shielded_address?: string;
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
