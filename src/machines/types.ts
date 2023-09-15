import { EventTxInput, EventTxOutput } from "../types";

export interface Context {
  socket: unknown;
  retryAttempt: number;
  event: unknown;
  initialEventId: null | number;
}

export interface DecodedScript {
  type: string;
  address: string;
  timelock?: number;
}

export interface Output {
  value: number;
  token_data: number;
  script: string;
  decodedScript: unknown;
  token: string;
  decoded: DecodedScript;
}

export interface Input {
  tx_id: string;
  index: number;
  token_data: number;
  script: string;
  decodedScript: unknown;
  token: string;
  decoded: DecodedScript;
}

export type FullNodeEvent = {
  type: string;
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

export type WebSocketEvent = 
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' };

export type MetadataDecidedEvent = {
  type: 'TX_VOIDED' | 'TX_NEW' | 'TX_FIRST_BLOCK' | 'IGNORE';
  originalEvent: FullNodeEvent;
}

export type WebSocketSendEvent = {
  // TODO: Well-defined types here
  message: string;
};

export type Event =
  | { type: 'WEBSOCKET_EVENT', event: WebSocketEvent }
  | { type: 'FULLNODE_EVENT', event: FullNodeEvent }
  | { type: 'METADATA_DECIDED', event: MetadataDecidedEvent }
  | { type: 'WEBSOCKET_SEND_EVENT', event: WebSocketSendEvent };
