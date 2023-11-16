/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export interface EventTxInput {
  tx_id: string;
  index: number;
  spent_output: EventTxOutput;
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

export interface LastSyncedEvent {
  id: number;
  last_event_id: number;
  updated_at: number;
}

