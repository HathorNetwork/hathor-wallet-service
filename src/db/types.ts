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
