/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Machine } from 'xstate';
import { WebSocket } from 'ws';


interface Context {
  socket: WebSocket | null;
}

type FullNodeEvent = {
  type: string;
  peer_id: string;
  id: number;
  timestamp: number;
  data: unknown;
}

type WebSocketEvent = 
  | { type: 'CONNECTED'; socket: WebSocket }
  | { type: 'DISCONNECT' };

type Event =
  | WebSocketEvent
  | FullNodeEvent;

const SyncMachine = Machine<Context, any, Event>({
  id: 'websocket',
  initial: 'CONNECTING',
  context: {
    socket: null,
  },
  invoke: {
    src: 'initializeWebSocket',
    onDone: 'CONNECTED',
  },
  states: {}
}, {
  actions: {}, 
  guards: {},
  services: {},
});

export default SyncMachine;

/*
TRUNCATE TABLE transaction;
TRUNCATE TABLE tx_output;
TRUNCATE TABLE address;
TRUNCATE TABLE address_balance;
TRUNCATE TABLE address_tx_history;
*/
