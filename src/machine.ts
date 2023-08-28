/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Machine, AssignAction, assign, AnyEventObject } from 'xstate';
import { WebSocket } from 'ws';
import {
  getDbConnection,
  addOrUpdateTx,
  addUtxos,
  updateTxOutputSpentBy,
  getTxOutputs,
  updateAddressTablesWithTx,
  handleVoidedTx,
} from './db';
import {
  TxOutputWithIndex,
  DbTxOutput,
  StringMap,
  TokenBalanceMap,
} from './types';
import { getAddressBalanceMap, prepareInputs, prepareOutputs } from './utils';

const WS_URL = 'ws://localhost:8083/v1a/event_ws';

interface Context {
  lastEventId: number | null;
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

const storeSocket: AssignAction<Context, Event> = assign({
  socket: (context, event) => {
    if (event.type !== 'CONNECTED') {
      return context.socket || null;
    }

    // @ts-ignore typescript is dumb, even with the check above it still thinks
    // that an event other than CONNECTED can reach this point.
    return event.socket;
  },
});

const storeEvent: AssignAction<Context, Event> = assign({
  // @ts-ignore
  lastEventId: (_context, event) => {
    if (!('id' in event)) return;

    return event.id;
  },
});

const websocketMachine = Machine<Context, any, Event>({
  id: 'websocket',
  initial: 'CONNECTING',
  context: {
    lastEventId: null,
    socket: null,
  },
  invoke: {
    src: 'initializeWebSocket',
    onDone: 'CONNECTED',
  },
  states: {
    CONNECTING: {
      on: {
        CONNECTED: {
          target: 'CONNECTED.idle',
          actions: 'storeSocket',
        },
      }
    },
    CONNECTED: {
      onEntry: 'startStream',
      on: {
        DISCONNECT: {
          target: 'CONNECTING',
        },
      },
      initial: 'idle',
      states: {
        idle: {
          on: {
            NEW_VERTEX_ACCEPTED: {
              actions: ['storeEvent'],
              target: 'handlingVertexAccepted',
            },
            VERTEX_METADATA_CHANGED: {
              actions: ['storeEvent'],
              target: 'handlingMetadataChanged',
            },
            LOAD_STARTED: {
              actions: ['storeEvent', 'sendAck'],
              target: 'idle',
            },
            ACK: {
              actions: 'sendAck'
            },
            '*': {
              actions: ['storeEvent', 'sendAck'],
              target: 'idle',
            }
          }
        },
        handlingMetadataChanged: {
          invoke: {
            src: 'handleMetadataChanged',
            data: (_context: Context, event: Event) => event,
            onDone: 'success',
            onError: 'error',
          },
        },
        handlingVertexAccepted: {
          invoke: {
            src: 'handleVertexAccepted',
            data: (_context: Context, event: Event) => event,
            onDone: 'success',
            onError: 'error',
          },
        },
        success: {
          entry: 'sendAck',
          always: [
            { target: 'idle' }
          ],
        },
        error: {
          type: 'final',
          entry: 'logError',
        },
      }
    }
  }
}, {
  actions: {
    storeSocket,
    storeEvent,
    logError: (_context: Context, event: Event) => {
      console.log('Got error!', event);
    },
    startStream: ({ socket }: Context, _event: Event) => {
      if (!socket) {
        throw new Error('Reached sendStartSteam but socket is not available.');
      }
      
      const message = {
        'type': 'START_STREAM',
        'window_size': 1,
      };

      socket.send(JSON.stringify(message));
    },
    sendAck: ({ socket, lastEventId }: Context) => {
      console.log('Last event: ', lastEventId);
      if (lastEventId === null) return;

      const message = {
        type: 'ACK',
        window_size: 1,
        ack_event_id: lastEventId,
      };

      if (!socket) {
        throw new Error('Reached sendAck but socket is not available.');
      }

      console.log('Sending ack', message);
      socket.send(JSON.stringify(message));
    }
  }, 
  services: {
    handleMetadataChanged: (_context: Context, receivedEvent: AnyEventObject) => async () => {
      const event = receivedEvent as FullNodeEvent;
      const mysql = await getDbConnection();

      // @ts-ignore
      const { hash, metadata: { height }, timestamp, version, weight, outputs, inputs, tokens } = event.data;

      // Add the transaction
      await addOrUpdateTx(
        mysql,
        hash,
        height,
        timestamp,
        version,
        weight,
      );

      const txOutputs: TxOutputWithIndex[] = prepareOutputs(outputs, tokens);
      // @ts-ignore
      const txInputs: DbTxOutput[] = await getTxOutputs(mysql, inputs.map((input: unknown) => ({ txId: input.tx_id, index: input.index })));

      const addressBalanceMap: StringMap<TokenBalanceMap> = getAddressBalanceMap(txInputs, txOutputs);

      await handleVoidedTx(mysql, hash, addressBalanceMap);
    },
    handleVertexAccepted: (_context: Context, receivedEvent: AnyEventObject) => async () => {
      const event = receivedEvent as FullNodeEvent;
      const mysql = await getDbConnection();

      // @ts-ignore
      const { hash, metadata: { height }, timestamp, version, weight, outputs, inputs, tokens } = event.data;

      // Add the transaction
      await addOrUpdateTx(
        mysql,
        hash,
        height,
        timestamp,
        version,
        weight,
      );

      const txOutputs: TxOutputWithIndex[] = prepareOutputs(outputs, tokens);
      // @ts-ignore
      const txInputs: DbTxOutput[] = await getTxOutputs(mysql, inputs.map((input: unknown) => ({ txId: input.tx_id, index: input.index })));

      // Add utxos
      await addUtxos(mysql, hash, txOutputs, null);
      await updateTxOutputSpentBy(mysql, txInputs, hash);

      // Handle genesis txs:
      if (txInputs.length > 0 || txOutputs.length > 0)  {
        const addressBalanceMap: StringMap<TokenBalanceMap> = getAddressBalanceMap(txInputs, txOutputs);

        // update address tables (address, address_balance, address_tx_history)
        await updateAddressTablesWithTx(mysql, hash, timestamp, addressBalanceMap);
      }

      await mysql.end();
    },
    updateDatabase: () => () => {
      return new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    },
    initializeWebSocket: () => (sendBack) => {
      const socket = new WebSocket(WS_URL);

      socket.onopen = () => {
        sendBack({ type: 'CONNECTED', socket });
      };

      socket.onmessage = (socketEvent) => {
        const data = JSON.parse(socketEvent.data.toString());
        const { event } = data;

        console.log(`Received ${event.type} from socket.`);

        sendBack(event);
      };

      socket.onclose = () => {
        sendBack('DISCONNECT');
      };

      return () => {
        console.log('Service closed.');
      };
    }
  },
});

export default websocketMachine;

/*
TRUNCATE TABLE transaction;
TRUNCATE TABLE tx_output;
TRUNCATE TABLE address;
TRUNCATE TABLE address_balance;
TRUNCATE TABLE address_tx_history;
*/
