/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export type WebSocketEvent =
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' };

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

export type HealthCheckEvent =
  | { type: 'START' }
  | { type: 'STOP' };

export enum EventTypes {
  WEBSOCKET_EVENT = 'WEBSOCKET_EVENT',
  FULLNODE_EVENT = 'FULLNODE_EVENT',
  METADATA_DECIDED = 'METADATA_DECIDED',
  WEBSOCKET_SEND_EVENT = 'WEBSOCKET_SEND_EVENT',
  HEALTHCHECK_EVENT = 'HEALTHCHECK_EVENT',
}

export enum FullNodeEventTypes {
  VERTEX_METADATA_CHANGED = 'VERTEX_METADATA_CHANGED',
  VERTEX_REMOVED = 'VERTEX_REMOVED',
  NEW_VERTEX_ACCEPTED = 'NEW_VERTEX_ACCEPTED',
  LOAD_STARTED = 'LOAD_STARTED',
  LOAD_FINISHED = 'LOAD_FINISHED',
  REORG_STARTED = 'REORG_STARTED',
  REORG_FINISHED= 'REORG_FINISHED',
}

export type MetadataDecidedEvent = {
  type: 'TX_VOIDED' | 'TX_UNVOIDED' | 'TX_NEW' | 'TX_FIRST_BLOCK' | 'IGNORE';
  originalEvent: FullNodeEvent;
}

export type Event =
  | { type: EventTypes.WEBSOCKET_EVENT, event: WebSocketEvent }
  | { type: EventTypes.FULLNODE_EVENT, event: FullNodeEvent }
  | { type: EventTypes.METADATA_DECIDED, event: MetadataDecidedEvent }
  | { type: EventTypes.WEBSOCKET_SEND_EVENT, event: WebSocketSendEvent }
  | { type: EventTypes.HEALTHCHECK_EVENT, event: HealthCheckEvent};


export interface VertexRemovedEventData {
  vertex_id: string;
}

export type FullNodeEventBase = {
  stream_id: string;
  peer_id: string;
  network: string;
  type: string;
  latest_event_id: number;
};

export type StandardFullNodeEvent = FullNodeEventBase & {
  event: {
    id: number;
    timestamp: number;
    type: Exclude<FullNodeEventTypes, "REORG_STARTED">; // All types except "REORG_STARTED"
    data: {
      hash: string;
      timestamp: number;
      version: number;
      weight: number;
      nonce: number;
      inputs: EventTxInput[];
      outputs: EventTxOutput[];
      headers?: EventTxHeader[];
      parents: string[];
      tokens: string[];
      token_name: null | string;
      token_symbol: null | string;
      signal_bits: number;
      metadata: {
        hash: string;
        voided_by: string[];
        first_block: null | string;
        height: number;
      };
    };
  };
};

export type ReorgFullNodeEvent = FullNodeEventBase & {
  event: {
    id: number;
    timestamp: number;
    type: "REORG_STARTED";
    data: {
      reorg_size: number;
      previous_best_block: string;
      new_best_block: string;
      common_block: string;
    };
    group_id: number;
  };
};

export type FullNodeEvent = StandardFullNodeEvent | ReorgFullNodeEvent;

export interface EventTxInput {
  tx_id: string;
  index: number;
  spent_output: EventTxOutput;
}

export interface EventTxOutput {
  value: bigint;
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

export interface EventTxNanoHeader {
    id: string;
    nc_seqnum: number;
    nc_id: string;
    nc_method: string;
    nc_address: string;
}

export type EventTxHeader = EventTxNanoHeader;
