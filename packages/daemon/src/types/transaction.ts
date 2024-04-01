/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export interface DbTxOutput {
  txId: string;
  index: number;
  tokenId: string;
  address: string;
  value: number;
  authorities: number;
  timelock: number | null;
  heightlock: number | null;
  locked: boolean;
  spentBy?: string | null;
  txProposalId?: string | null;
  txProposalIndex?: number | null;
  voided?: boolean | null;
}

export interface DbTransaction {
  tx_id: string;
  timestamp: number;
  version: number;
  voided: boolean;
  height?: number | null;
  weight?: number | null;
  created_at: number;
  updated_at: number;
}
