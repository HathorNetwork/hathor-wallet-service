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
