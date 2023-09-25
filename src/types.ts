/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export interface EventTxInput {
  tx_id: string;
  index: number;
  value: number;
  script: string;
  token_data: number;
}

export interface EventTxOutput {
  value: number;
  token_data: number;
  script: string;
  locked?: boolean;
  decoded: {
    type: string;
    address: string;
    timelock: number | null;
  };
}

export interface DecodedOutput {
  type: string;
  address: string;
  timelock: number | null;
}

export interface TxOutput {
  value: number;
  script: string;
  token: string;
  decoded: DecodedOutput | null;
  // eslint-disable-next-line camelcase
  spent_by?: string | null;
  // eslint-disable-next-line camelcase
  token_data: number;
  locked?: boolean;
}

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
  txProposalId?: string;
  txProposalIndex?: number;
  voided?: boolean | null;
}

export interface TxOutputWithIndex extends TxOutput {
  index: number;
}

export interface TxInput {
  // eslint-disable-next-line camelcase
  tx_id: string;
  index: number;
  value: number;
  // eslint-disable-next-line camelcase
  token_data: number;
  script: string;
  token: string;
  decoded: DecodedOutput | null;
}

export interface EventTxInput {
  tx_id: string;
  index: number;
  value: number;
  script: string;
  token_data: number;
}

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
  txProposalId?: string;
  txProposalIndex?: number;
  voided?: boolean | null;
}

export interface StringMap<T> {
  [x: string]: T;
}

