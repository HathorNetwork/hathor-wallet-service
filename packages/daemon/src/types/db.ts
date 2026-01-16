/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { RowDataPacket } from 'mysql2/promise';
import { TokenVersion } from '@hathor/wallet-lib';

export interface TxOutputRow extends RowDataPacket {
  tx_id: string;
  index: number;
  token_id: string;
  address: string;
  value: number;
  authorities: number;
  timelock: number;
  heightlock: number;
  locked: boolean;
  tx_proposal?: string;
  tx_proposal_index?: number;
  spent_by?: string;
}

export interface LastSyncedEventRow extends RowDataPacket {
  id: number;
  last_event_id: number;
  updated_at: number;
}

export interface AddressBalanceRow extends RowDataPacket {
  address: string;
  token_id: string;
  unlocked_balance: number;
  locked_balance: number;
  locked_authorities: number;
  unlocked_authorities: number;
  timelock_expires: number;
  transactions: number;
}

export interface AddressTxHistorySumRow extends RowDataPacket {
  address: string;
  token_id: string;
  balance: string;
  transactions: string;
}

export interface AddressTableRow extends RowDataPacket {
  address: string;
  index: number;
  wallet_id: string;
  transactions: number;
}

export interface TransactionTableRow extends RowDataPacket {
  tx_id: string;
  timestamp: number;
  version: number;
  voided: boolean;
  height: number;
}

export interface AddressBalanceRow extends RowDataPacket {
  address: string;
  token_id: string;
  unlocked_balance: number;
  locked_balance: number;
  locked_authorities: number;
  unlocked_authorities: number;
  timelock_expires: number;
  transactions: number;
  total_received: number;
  created_at: number;
  updated_at: number;
}

export interface AddressTxHistoryRow extends RowDataPacket {
  address: string;
  tx_id: string;
  token_id: string;
  balance: number;
  timestamp: number;
  voided: boolean;
}

export interface TransactionRow extends RowDataPacket {
  tx_id: string;
  timestamp: number;
  version: number;
  voided: boolean;
  height?: number | null;
  weight?: number | null;
  created_at: number;
  updated_at: number;
}

export interface WalletBalanceRow extends RowDataPacket {
  wallet_id: string;
  token_id: string;
  unlocked_balance: number;
  locked_balance: number;
  unlocked_authorities: number;
  locked_authorities: number;
  timelock_expires?: number | null;
  transactions: number;
  total_received: number;
}

export interface MinerRow extends RowDataPacket {
  address: string;
  first_block: string;
  last_block: string;
  count: number;
}

export interface TokenInformationRow extends RowDataPacket {
  id: string;
  name: string;
  symbol: string;
  transactions: number;
  version: TokenVersion;
  created_at: number;
  updated_at: number;
}

export interface WalletTxHistoryRow extends RowDataPacket {
  wallet_id: string;
  token_id: string;
  tx_id: string;
  balance: number;
  timestamp: number;
  voided: boolean;
}

export interface BestBlockRow extends RowDataPacket {
  height: number;
}

export interface TokenSymbolsRow extends RowDataPacket {
  id: string;
  symbol: string;
}

export interface MaxAddressIndexRow extends RowDataPacket {
  max_among_addresses: number,
  max_wallet_index: number
}

export interface AddressesWalletsRow extends RowDataPacket {
  address: string,
  wallet_id: string,
  auth_xpubkey: string,
  xpubkey: string,
  maxGap: number,
}

export interface AddressRow extends RowDataPacket {
  address: string,
  index: number,
  wallet_id: string,
  transactions: number,
  seqnum: number,
}
