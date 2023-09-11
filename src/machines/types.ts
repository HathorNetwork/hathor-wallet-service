export interface Context {
  socket: WebSocket | null;
  retryAttempt: number;
  lastEventId: null | number;
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
      inputs: Input[];
      outputs: Output[];
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

export interface Output {
  value: number;
  script: string;
  token_data: number;
}

interface Input {
  tx_id: string;
  index: number;
  data: string;
}

export type WebSocketEvent = 
  | { type: 'CONNECTED'; socket: WebSocket }
  | { type: 'DISCONNECTED' };

export type Event =
  | { type: 'WEBSOCKET_EVENT', event: WebSocketEvent }
  | { type: 'FULLNODE_EVENT', event: FullNodeEvent };
