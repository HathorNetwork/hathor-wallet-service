/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Machine,
  assign,
  spawn,
  send,
  AssignAction,
} from 'xstate';
import { hashTxData, LRU } from '../utils';
import { WebSocketActor } from '../actors';
import {
  Context,
  Event,
} from './types';
import {
  handleVertexAccepted,
  metadataDiff,
  handleVoidedTx,
  handleTxFirstBlock,
  updateLastSyncedEvent,
  fetchInitialState,
} from '../services';

const RETRY_BACKOFF_INCREASE = 1000; // 1s increase in the backoff strategy
const MAX_BACKOFF_RETRIES = 10; // The retry backoff will top at 10s

export const TxCache = new LRU(10000);

const storeEvent: AssignAction<Context, Event> = assign({
  // @ts-ignore
  event: (context: Context, event: Event) => {
    if (event.type !== 'FULLNODE_EVENT') {
      return context.event;
    }
    if (!('id' in event.event.event)) return;

    return event.event;
  },
});

const SyncMachine = Machine<Context, any, Event>({
  id: 'websocket',
  initial: 'INITIALIZING',
  context: {
    socket: null,
    retryAttempt: 0,
    event: null,
    initialEventId: null,
  },
  states: {
    INITIALIZING: {
      invoke: {
        src: 'fetchInitialState',
        onDone: {
          actions: ['storeInitialState'],
          target: 'CONNECTING',
        },
      },
    },
    CONNECTING: {
      entry: assign({
        socket: () => spawn(WebSocketActor),
      }),
      on: {
        'WEBSOCKET_EVENT': [{
          cond: 'websocketDisconnected',
          target: 'RECONNECTING',
        }, {
          target: 'CONNECTED',
        }],
      }
    },
    RECONNECTING: {
      onEntry: ['clearSocket'],
      after: {
        RETRY_BACKOFF_INCREASE: 'CONNECTING',
      },
    },
    CONNECTED: {
      id: 'CONNECTED',
      initial: 'validateNetwork',
      states: {
        validateNetwork: {
          invoke: {
            src: 'validateNetwork',
            onDone: {
              target: 'idle',
              actions: ['startStream'],
            },
            onError: '#final-error',
          },
        },
        idle: {
          id: 'idle',
          on: {
            FULLNODE_EVENT: [{
              cond: 'invalidPeerId',
              target: '#final-error',
            }, {
              actions: ['storeEvent', 'sendAck'],
              cond: 'unchanged',
              target: 'idle',
            }, {
              actions: ['storeEvent'],
              cond: 'metadataChanged',
              target: 'handlingMetadataChanged',
            }, {
              actions: ['storeEvent'],
              cond: 'vertexAccepted',
              target: 'handlingVertexAccepted',
            }, {
              actions: ['storeEvent'],
              target: 'handlingUnhandledEvent',
            }],
          },
        },
        handlingUnhandledEvent: {
          invoke: {
            src: 'updateLastSyncedEvent',
            onDone: {
              actions: ['sendAck'],
              target: 'idle',
            },
            onError: '#final-error',
          },
        },
        handlingMetadataChanged: {
          id: 'handlingMetadataChanged',
          initial: 'detectingDiff',
          states: {
            detectingDiff: {
              invoke: {
                src: 'metadataDiff',
                onDone: {
                  actions: send((_context, event) => ({ 
                    type: 'METADATA_DECIDED',
                    event: event.data,
                  }))
                },
              },
              on: {
                'METADATA_DECIDED': [
                  { target: '#handlingVoidedTx', cond: 'metadataVoided', actions: ['unwrapEvent'] },
                  { target: '#handleVertexAccepted', cond: 'metadataNewTx', actions: ['unwrapEvent'] },
                  { target: '#handlingFirstBlock', cond: 'metadataFirstBlock', actions: ['unwrapEvent'] },
                  { target: '#idle', cond: 'metadataIgnore', actions: ['unwrapEvent'] },
                ],
              }
            },
          }
        },
        // We have the unchanged guard, so it's guaranteed that this is a new tx
        handlingVertexAccepted: {
          id: 'handleVertexAccepted',
          invoke: {
            src: 'handleVertexAccepted',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
              actions: ['sendAck'],
            },
            onError: '#final-error',
          },
        },
        handlingVoidedTx: {
          id: 'handlingVoidedTx',
          invoke: {
            src: 'handleVoidedTx',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
              actions: ['sendAck'],
            },
            onError: '#final-error',
          },
        },
        handlingFirstBlock: {
          id: 'handlingFirstBlock',
          invoke: {
            src: 'handleTxFirstBlock',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
              actions: ['sendAck'],
            },
            onError: '#final-error',
          },
        },
      },
      on: {
        'WEBSOCKET_EVENT': [{
          cond: 'websocketDisconnected',
          target: 'RECONNECTING',
        }],
      }
    },
    ERROR: {
      id: 'final-error',
      type: 'final',
    }
  },
}, {
  guards: {
    metadataIgnore: (_context, event: Event) => {
      if (event.type !== 'METADATA_DECIDED') {
        return false;
      }

      return event.event.type === 'IGNORE';
    },
    metadataVoided: (_context, event: Event) => {
      if (event.type !== 'METADATA_DECIDED') {
        return false;
      }

      return event.event.type === 'TX_VOIDED';
    },
    metadataNewTx: (_context, event: Event) => {
      if (event.type !== 'METADATA_DECIDED') {
        return false;
      }

      return event.event.type === 'TX_NEW';
    },
    metadataFirstBlock: (_context, event: Event) => {
      if (event.type !== 'METADATA_DECIDED') {
        return false;
      }

      return event.event.type === 'TX_FIRST_BLOCK';
    },
    metadataChanged: (_context, event: Event) => {
      if (event.type !== 'FULLNODE_EVENT') {
        return false;
      }

      return event.event.event.type === 'VERTEX_METADATA_CHANGED';
    },
    vertexAccepted: (_context, event: Event) => {
      if (event.type !== 'FULLNODE_EVENT') {
        return false;
      }

      return event.event.event.type === 'NEW_VERTEX_ACCEPTED';
    },
    invalidPeerId: () => {
      return false;
    },
    websocketDisconnected: (_context, event: Event) => {
      if (event.type === 'WEBSOCKET_EVENT'
          && event.event.type === 'DISCONNECTED') {
        return true;
      }

      return false;
    },
    unchanged: (_context: Context, event: Event) => {
      if (event.type !== 'FULLNODE_EVENT') {
        return true;
      }

      const { data } = event.event.event;

      const txHashFromCache = TxCache.get(data.hash);
      // Not on the cache, it's not unchanged.
      if (!txHashFromCache) {
        return false;
      }

      const txHashFromEvent = hashTxData(data.metadata);

      return txHashFromCache === txHashFromEvent;
    },
  },
  delays: {
    BACKOFF_DELAYED_RECONNECT: (context: Context) => {
      if (context.retryAttempt > MAX_BACKOFF_RETRIES) {
        return MAX_BACKOFF_RETRIES * RETRY_BACKOFF_INCREASE;
      }

      return context.retryAttempt * RETRY_BACKOFF_INCREASE;
    },
  },
  actions: {
    storeInitialState: assign({
      initialEventId: (_context: Context, event: Event) => {
        // @ts-ignore
        console.log('Storing initial event id: ', event.data);
        // @ts-ignore
        return event.data.lastEventId;
      },
    }),
    unwrapEvent: assign({
      event: (_context: Context, event: Event) => {
        if (event.type !== 'METADATA_DECIDED') {
          return;
        }

        return event.event.originalEvent.event;
      },
    }),
    startStream: send((context: Context, _event) => ({
      type: 'WEBSOCKET_SEND_EVENT',
      event: {
        message: JSON.stringify({
          type: 'START_STREAM',
          window_size: 1,
          last_ack_event_id: context.initialEventId,
        }),
      },
    }), {
      // @ts-ignore
      to: (context: Context) => context.socket.id,
    }),
    clearSocket: assign({
      socket: null,
    }),
    storeEvent,
    sendAck: send((context: Context, _event) => {
      // @ts-ignore
      return {
        type: 'WEBSOCKET_SEND_EVENT',
        event: {
          message: JSON.stringify({
            type: 'ACK',
            window_size: 1,
            // @ts-ignore
            ack_event_id: context.event.event.id,
          }),
        },
      };
    }, {
      // @ts-ignore
      to: (context: Context) => context.socket.id,
    }),
  }, 
  services: {
    initializeWebSocket: async (_context: Context, _event: Event) => {
      return Promise.resolve();
    },
    validateNetwork: async (_context: Context, _event: Event) => {
      // Here we should request the fullnode API to get the network and
      // validate it.
      return Promise.resolve();
    },
    handleVoidedTx,
    handleVertexAccepted,
    handleTxFirstBlock,
    metadataDiff,
    updateLastSyncedEvent,
    fetchInitialState,
  },
});

export default SyncMachine;
