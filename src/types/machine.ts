/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { EventTxInput, EventTxOutput } from '../types';
import { ActorRef } from 'xstate';
import { LRU } from '../utils';

export type FullNodeEvent = {
  stream_id: string;
  type: string;
  latest_event_id: number;
  event: {
    peer_id: string;
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

export interface Context {
  socket: ActorRef<any, any> | null;
  retryAttempt: number;
  event?: FullNodeEvent | null;
  initialEventId: null | number;
  txCache: LRU;
}

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

export type Event =
  | { type: 'WEBSOCKET_EVENT', event: WebSocketEvent }
  | { type: 'FULLNODE_EVENT', event: FullNodeEvent }
  | { type: 'METADATA_DECIDED', event: MetadataDecidedEvent }
  | { type: 'WEBSOCKET_SEND_EVENT', event: WebSocketSendEvent };
