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
