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
<<<<<<< HEAD
} from 'xstate';
import { LRU } from '../utils';
=======
  send,
  AssignAction,
} from 'xstate';
import { hashTxData, LRU } from '../utils';
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
import { WebSocketActor } from '../actors';
import {
  Context,
  Event,
<<<<<<< HEAD
} from '../types';
=======
} from './types';
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
import {
  handleVertexAccepted,
  metadataDiff,
  handleVoidedTx,
  handleTxFirstBlock,
  updateLastSyncedEvent,
  fetchInitialState,
<<<<<<< HEAD
  handleUnvoidedTx,
} from '../services';
import {
  metadataIgnore,
  metadataVoided,
  metadataUnvoided,
  metadataNewTx,
  metadataFirstBlock,
  metadataChanged,
  vertexAccepted,
  invalidPeerId,
  invalidStreamId,
  invalidNetwork,
  websocketDisconnected,
  voided,
  unchanged,
} from '../guards';
import {
  storeInitialState,
  unwrapEvent,
  startStream,
  clearSocket,
  storeEvent,
  sendAck,
  metadataDecided,
  increaseRetry,
  logEventError,
  updateCache,
} from '../actions';
import { BACKOFF_DELAYED_RECONNECT } from '../delays';
import getConfig from '../config';

export const SYNC_MACHINE_STATES = {
  INITIALIZING: 'INITIALIZING',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  ERROR: 'ERROR',
};

export const CONNECTED_STATES = {
  idle: 'idle',
  handlingUnhandledEvent: 'handlingUnhandledEvent',
  handlingMetadataChanged: 'handlingMetadataChanged',
  handlingVertexAccepted: 'handlingVertexAccepted',
  handlingVoidedTx: 'handlingVoidedTx',
  handlingUnvoidedTx: 'handlingUnvoidedTx',
  handlingFirstBlock: 'handlingFirstBlock',
};

const { TX_CACHE_SIZE } = getConfig();

const SyncMachine = Machine<Context, any, Event>({
  id: 'SyncMachine',
  initial: SYNC_MACHINE_STATES.INITIALIZING,
=======
  validateNetwork,
} from '../services';
import logger from '../logger';

const RETRY_BACKOFF_INCREASE = 1000; // 1s increase in the backoff strategy
const MAX_BACKOFF_RETRIES = 10; // The retry backoff will top at 10s

export const TxCache = new LRU(parseInt(process.env.TX_CACHE_SIZE || '10000', 10));

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
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
  context: {
    socket: null,
    retryAttempt: 0,
    event: null,
    initialEventId: null,
<<<<<<< HEAD
    txCache: new LRU(TX_CACHE_SIZE),
  },
  states: {
    [SYNC_MACHINE_STATES.INITIALIZING]: {
=======
  },
  states: {
    INITIALIZING: {
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
      invoke: {
        src: 'fetchInitialState',
        onDone: {
          actions: ['storeInitialState'],
<<<<<<< HEAD
          target: SYNC_MACHINE_STATES.CONNECTING,
        },
        onError: {
          target: `#${SYNC_MACHINE_STATES.ERROR}`,
        },
      },
    },
    [SYNC_MACHINE_STATES.CONNECTING]: {
=======
          target: 'CONNECTING',
        },
      },
    },
    CONNECTING: {
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
      entry: assign({
        socket: () => spawn(WebSocketActor),
      }),
      on: {
<<<<<<< HEAD
        WEBSOCKET_EVENT: [{
          cond: 'websocketDisconnected',
          target: SYNC_MACHINE_STATES.RECONNECTING,
        }, {
          target: SYNC_MACHINE_STATES.CONNECTED,
        }],
      },
    },
    [SYNC_MACHINE_STATES.RECONNECTING]: {
      onEntry: ['clearSocket', 'increaseRetry'],
      after: {
        BACKOFF_DELAYED_RECONNECT: SYNC_MACHINE_STATES.CONNECTING,
      },
    },
    [SYNC_MACHINE_STATES.CONNECTED]: {
      id: SYNC_MACHINE_STATES.CONNECTED,
      initial: CONNECTED_STATES.idle,
      entry: ['startStream'],
      states: {
        [CONNECTED_STATES.idle]: {
          id: CONNECTED_STATES.idle,
          on: {
            FULLNODE_EVENT: [{
              cond: 'invalidStreamId',
              target: `#${SYNC_MACHINE_STATES.ERROR}`,
            }, {
              cond: 'invalidPeerId',
              target: `#${SYNC_MACHINE_STATES.ERROR}`,
            }, {
              cond: 'invalidNetwork',
              target: `#${SYNC_MACHINE_STATES.ERROR}`,
            }, {
              actions: ['storeEvent', 'sendAck'],
              cond: 'unchanged',
              target: CONNECTED_STATES.idle,
            }, {
              actions: ['storeEvent'],
              cond: 'metadataChanged',
              target: CONNECTED_STATES.handlingMetadataChanged,
            }, {
              actions: ['storeEvent', 'sendAck'],
              /* If the transaction is already voided and is not
               * VERTEX_METADATA_CHANGED, we should ignore it.
               */
              cond: 'voided',
              target: CONNECTED_STATES.idle,
            }, {
              actions: ['storeEvent'],
              cond: 'vertexAccepted',
              target: CONNECTED_STATES.handlingVertexAccepted,
            }, {
              actions: ['storeEvent'],
              target: CONNECTED_STATES.handlingUnhandledEvent,
            }],
          },
        },
        [CONNECTED_STATES.handlingUnhandledEvent]: {
          id: CONNECTED_STATES.handlingUnhandledEvent,
=======
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
              cond: 'invalidStreamId',
              target: '#final-error',
            }, {
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
          id: 'handlingUnhandledEvent',
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
          invoke: {
            src: 'updateLastSyncedEvent',
            onDone: {
              actions: ['sendAck'],
              target: 'idle',
            },
<<<<<<< HEAD
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingMetadataChanged]: {
=======
            onError: '#final-error',
          },
        },
        handlingMetadataChanged: {
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
          id: 'handlingMetadataChanged',
          initial: 'detectingDiff',
          states: {
            detectingDiff: {
              invoke: {
                src: 'metadataDiff',
<<<<<<< HEAD
                onDone: { actions: ['metadataDecided'] },
              },
              on: {
                METADATA_DECIDED: [
                  { target: `#${CONNECTED_STATES.handlingVoidedTx}`, cond: 'metadataVoided', actions: ['unwrapEvent'] },
                  { target: `#${CONNECTED_STATES.handlingUnvoidedTx}`, cond: 'metadataUnvoided', actions: ['unwrapEvent'] },
                  { target: `#${CONNECTED_STATES.handlingVertexAccepted}`, cond: 'metadataNewTx', actions: ['unwrapEvent'] },
                  { target: `#${CONNECTED_STATES.handlingFirstBlock}`, cond: 'metadataFirstBlock', actions: ['unwrapEvent'] },
                  { target: `#${CONNECTED_STATES.handlingUnhandledEvent}`, cond: 'metadataIgnore' },
                ],
              },
            },
          },
        },
        // We have the unchanged guard, so it's guaranteed that this is a new tx
        [CONNECTED_STATES.handlingVertexAccepted]: {
          id: CONNECTED_STATES.handlingVertexAccepted,
=======
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
                  { target: '#handlingUnhandledEvent', cond: 'metadataIgnore' },
                ],
              }
            },
          }
        },
        // We have the unchanged guard, so it's guaranteed that this is a new tx
        handlingVertexAccepted: {
          id: 'handleVertexAccepted',
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
          invoke: {
            src: 'handleVertexAccepted',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
<<<<<<< HEAD
              actions: ['sendAck', 'storeEvent', 'updateCache'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingVoidedTx]: {
          id: CONNECTED_STATES.handlingVoidedTx,
=======
              actions: ['sendAck'],
            },
            onError: '#final-error',
          },
        },
        handlingVoidedTx: {
          id: 'handlingVoidedTx',
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
          invoke: {
            src: 'handleVoidedTx',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
<<<<<<< HEAD
              actions: ['storeEvent', 'sendAck', 'updateCache'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingUnvoidedTx]: {
          id: CONNECTED_STATES.handlingUnvoidedTx,
          invoke: {
            src: 'handleUnvoidedTx',
            data: (_context: Context, event: Event) => event,
            onDone: {
              // The handleUnvoidedTx will remove the tx from the database, we should
              // re-add it:
              target: `#${CONNECTED_STATES.handlingVertexAccepted}`,
              // We shouldn't send ACK, as we'll send the ACK after handlingVertexAccepted
              actions: ['storeEvent', 'updateCache'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingFirstBlock]: {
          id: CONNECTED_STATES.handlingFirstBlock,
=======
              actions: ['sendAck'],
            },
            onError: '#final-error',
          },
        },
        handlingFirstBlock: {
          id: 'handlingFirstBlock',
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
          invoke: {
            src: 'handleTxFirstBlock',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
<<<<<<< HEAD
              actions: ['storeEvent', 'sendAck', 'updateCache'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
=======
              actions: ['sendAck'],
            },
            onError: '#final-error',
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
          },
        },
      },
      on: {
<<<<<<< HEAD
        WEBSOCKET_EVENT: [{
          cond: 'websocketDisconnected',
          target: SYNC_MACHINE_STATES.RECONNECTING,
        }],
      },
    },
    [SYNC_MACHINE_STATES.ERROR]: {
      id: SYNC_MACHINE_STATES.ERROR,
      type: 'final',
      onEntry: ['logEventError'],
    },
  },
}, {
  guards: {
    invalidStreamId,
    invalidPeerId,
    invalidNetwork,
    metadataIgnore,
    metadataVoided,
    metadataUnvoided,
    metadataNewTx,
    metadataFirstBlock,
    metadataChanged,
    vertexAccepted,
    websocketDisconnected,
    voided,
    unchanged,
  },
  delays: { BACKOFF_DELAYED_RECONNECT },
  actions: {
    storeInitialState,
    unwrapEvent,
    startStream,
    clearSocket,
    storeEvent,
    sendAck,
    metadataDecided,
    increaseRetry,
    logEventError,
    updateCache,
  },
  services: {
    handleVoidedTx,
    handleUnvoidedTx,
=======
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
    invalidPeerId: (_context, event: Event) => {
      // @ts-ignore
      return event.event.event.peer_id === process.env.FULLNODE_PEER_ID;
    },
    invalidStreamId: (_context, event: Event) => {
      // @ts-ignore
      return event.event.stream_id === process.env.STREAM_ID;
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
        logger.info('Storing initial event id: ', event.data);
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
    validateNetwork,
    handleVoidedTx,
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
    handleVertexAccepted,
    handleTxFirstBlock,
    metadataDiff,
    updateLastSyncedEvent,
    fetchInitialState,
  },
});

export default SyncMachine;
<<<<<<< HEAD
=======

>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
