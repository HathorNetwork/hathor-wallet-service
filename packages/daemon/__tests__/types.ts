import { TokenVersion } from '@hathor/wallet-lib';

export interface AddressTableEntry {
  address: string;
  index?: number | null;
  walletId?: string | null;
  transactions: number;
}

export interface TransactionTableEntry {
  txId: string;
  timestamp: number;
  version: number;
  voided: boolean;
  height: number;
}

export interface WalletBalanceEntry {
  walletId: string;
  tokenId: string;
  unlockedBalance: number;
  lockedBalance: number;
  unlockedAuthorities: number;
  lockedAuthorities: number;
  timelockExpires?: number | null;
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

export interface TokenTableEntry {
  id: string;
  name: string;
  symbol: string;
  version: TokenVersion;
  transactions: number;
}

export type Token = {
  tokenId: string;
  tokenSymbol: string;
  tokenName: string;
  transactions: number;
}

export interface AddressTxHistoryTableEntry {
  address: string;
  txId: string;
  tokenId: string;
  balance: number;
  timestamp: number;
  voided?: boolean;
}
