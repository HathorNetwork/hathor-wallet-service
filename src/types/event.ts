/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export type WebSocketEvent =
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' };

export type MetadataDecidedEvent = {
  type: 'TX_VOIDED' | 'TX_UNVOIDED' | 'TX_NEW' | 'TX_FIRST_BLOCK' | 'IGNORE';
  originalEvent: FullNodeEvent;
}

export type WebSocketSendEvent = 
  | {
      type: 'START_STREAM';
      window_size: number;
      last_ack_event_id?: number;
  }
  | {
      type: 'ACK';
      window_size: number;
      ack_event_id?: number;
  };

export enum EventTypes {
  WEBSOCKET_EVENT = 'WEBSOCKET_EVENT',
  FULLNODE_EVENT = 'FULLNODE_EVENT',
  METADATA_DECIDED = 'METADATA_DECIDED',
  WEBSOCKET_SEND_EVENT = 'WEBSOCKET_SEND_EVENT',
}

export type Event =
  | { type: EventTypes.WEBSOCKET_EVENT, event: WebSocketEvent }
  | { type: EventTypes.FULLNODE_EVENT, event: FullNodeEvent }
  | { type: EventTypes.METADATA_DECIDED, event: MetadataDecidedEvent }
  | { type: EventTypes.WEBSOCKET_SEND_EVENT, event: WebSocketSendEvent };

export type FullNodeEvent = {
  stream_id: string;
  peer_id: string;
  network: string;
  type: string;
  latest_event_id: number;
  event: {
    id: number;
    timestamp: number;
    type: string;
    data: {
      hash: string;
      timestamp: number;
      version: number;
      weight: number;
      inputs: EventTxInput[];
      outputs: EventTxOutput[];
      tokens: string[];
      token_name: null | string;
      token_symbol: null | string;
      metadata: {
        hash: string;
        voided_by: string[];
        first_block: null | string;
        height: number;
      };
    }
  }
}

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

