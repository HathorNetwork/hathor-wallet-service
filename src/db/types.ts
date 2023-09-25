import { RowDataPacket } from 'mysql2/promise';

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
  balance: number;
  transactions: number;
}
