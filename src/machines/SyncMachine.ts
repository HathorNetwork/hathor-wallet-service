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
  validateNetwork: 'validateNetwork',
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
  context: {
    socket: null,
    retryAttempt: 0,
    event: null,
    initialEventId: null,
    txCache: new LRU(TX_CACHE_SIZE),
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
      onEntry: ['clearSocket', 'increaseRetry'],
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
              target: CONNECTED_STATES.idle,
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
          invoke: {
            src: 'updateLastSyncedEvent',
            onDone: {
              actions: ['sendAck'],
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
          invoke: {
            src: 'handleVertexAccepted',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
              actions: ['sendAck', 'storeEvent', 'updateCache'],
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
              target: `#${CONNECTED_STATES.handlingVertexAccepted}`,
              actions: ['storeEvent', 'sendAck', 'updateCache'],
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
              actions: ['storeEvent', 'sendAck', 'updateCache'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
      },
      on: {
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
    metadataIgnore,
    metadataVoided,
    metadataUnvoided,
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
    increaseRetry,
    logEventError,
    updateCache,
  },
  services: {
    validateNetwork,
    handleVoidedTx,
    handleUnvoidedTx,
    handleVertexAccepted,
    handleTxFirstBlock,
    metadataDiff,
    updateLastSyncedEvent,
    fetchInitialState,
  },
});

export default SyncMachine;
