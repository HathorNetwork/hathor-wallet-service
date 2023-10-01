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
} from 'xstate';
import { LRU } from '../utils';
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
  validateNetwork,
} from '../services';
import {
  metadataIgnore,
  metadataVoided,
  metadataNewTx,
  metadataFirstBlock,
  metadataChanged,
  vertexAccepted,
  invalidPeerId,
  invalidStreamId,
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
} from '../actions';
import { BACKOFF_DELAYED_RECONNECT } from '../delays';
import logger from '../logger';

export const TxCache = new LRU(parseInt(process.env.TX_CACHE_SIZE || '10000', 10));

const SYNC_MACHINE_STATES = {
  INITIALIZING: 'INITIALIZING',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  ERROR: 'ERROR',
};

const CONNECTED_STATES = {
  idle: 'idle',
  validateNetwork: 'validateNetwork',
  handlingUnhandledEvent: 'handlingUnhandledEvent',
  handlingMetadataChanged: 'handlingMetadataChanged',
  handlingVertexAccepted: 'handlingVertexAccepted',
  handlingVoidedTx: 'handlingVoidedTx',
  handlingFirstBlock: 'handlingFirstBlock',
};

const SyncMachine = Machine<Context, any, Event>({
  id: 'SyncMachine',
  initial: SYNC_MACHINE_STATES.INITIALIZING,
  context: {
    socket: null,
    retryAttempt: 0,
    event: null,
    initialEventId: null,
  },
  states: {
    [SYNC_MACHINE_STATES.INITIALIZING]: {
      invoke: {
        src: 'fetchInitialState',
        onDone: {
          actions: ['storeInitialState'],
          target: 'CONNECTING',
        },
        onError: {
          target: `#${SYNC_MACHINE_STATES.ERROR}`,
        },
      },
    },
    [SYNC_MACHINE_STATES.CONNECTING]: {
      entry: assign({
        socket: () => spawn(WebSocketActor),
      }),
      on: {
        WEBSOCKET_EVENT: [{
          cond: 'websocketDisconnected',
          target: 'RECONNECTING',
        }, {
          target: 'CONNECTED',
        }],
      },
    },
    [SYNC_MACHINE_STATES.RECONNECTING]: {
      onEntry: ['clearSocket'],
      after: {
        BACKOFF_DELAYED_RECONNECT: 'CONNECTING',
      },
    },
    [SYNC_MACHINE_STATES.CONNECTED]: {
      id: SYNC_MACHINE_STATES.CONNECTED,
      initial: CONNECTED_STATES.validateNetwork,
      states: {
        [CONNECTED_STATES.validateNetwork]: {
          invoke: {
            src: 'validateNetwork',
            onDone: {
              target: 'idle',
              actions: ['startStream'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
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
              actions: ['storeEvent', 'sendAck'],
              cond: 'unchanged',
              target: 'idle',
            }, {
              actions: ['storeEvent'],
              cond: 'metadataChanged',
              target: 'handlingMetadataChanged',
            }, {
              actions: ['storeEvent', 'sendAck'],
              /* If the transaction is already voided and is not
               * VERTEX_METADATA_CHANGED, we should ignore it.
               */
              cond: 'voided',
              target: 'idle',
            }, {
              actions: ['storeEvent'],
              cond: 'vertexAccepted',
              target: 'handlingVertexAccepted',
            }, {
              target: 'handlingUnhandledEvent',
            }],
          },
        },
        [CONNECTED_STATES.handlingUnhandledEvent]: {
          id: CONNECTED_STATES.handlingUnhandledEvent,
          invoke: {
            src: 'updateLastSyncedEvent',
            onDone: {
              actions: ['sendAck', 'storeEvent'],
              target: 'idle',
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingMetadataChanged]: {
          id: 'handlingMetadataChanged',
          initial: 'detectingDiff',
          states: {
            detectingDiff: {
              invoke: {
                src: 'metadataDiff',
                onDone: { actions: ['metadataDecided'] },
              },
              on: {
                METADATA_DECIDED: [
                  { target: `#${CONNECTED_STATES.handlingVoidedTx}`, cond: 'metadataVoided', actions: ['unwrapEvent'] },
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
          invoke: {
            src: 'handleVertexAccepted',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
              actions: ['sendAck', 'storeEvent'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingVoidedTx]: {
          id: CONNECTED_STATES.handlingVoidedTx,
          invoke: {
            src: 'handleVoidedTx',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
              actions: ['storeEvent', 'sendAck'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingFirstBlock]: {
          id: CONNECTED_STATES.handlingFirstBlock,
          invoke: {
            src: 'handleTxFirstBlock',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
              actions: ['storeEvent', 'sendAck'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
      },
      on: {
        WEBSOCKET_EVENT: [{
          cond: 'websocketDisconnected',
          target: 'RECONNECTING',
          actions: (context: Context, event: Event) => {
            console.log('Websocket disconnected', event, context);
          },
        }],
      },
    },
    [SYNC_MACHINE_STATES.ERROR]: {
      id: SYNC_MACHINE_STATES.ERROR,
      type: 'final',
      onEntry: (_context: Context, event: Event) => {
        logger.error('Machine transitioned to error', event);
      }
    },
  },
}, {
  guards: {
    invalidStreamId,
    metadataIgnore,
    metadataVoided,
    metadataNewTx,
    metadataFirstBlock,
    metadataChanged,
    vertexAccepted,
    invalidPeerId,
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
  },
  services: {
    validateNetwork,
    handleVoidedTx,
    handleVertexAccepted,
    handleTxFirstBlock,
    metadataDiff,
    updateLastSyncedEvent,
    fetchInitialState,
  },
});

export default SyncMachine;
