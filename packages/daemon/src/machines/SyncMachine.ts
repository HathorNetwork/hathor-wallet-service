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
import { WebSocketActor, HealthCheckActor, MonitoringActor } from '../actors';
import {
  Context,
  Event,
} from '../types';
import {
  handleVertexAccepted,
  handleVertexRemoved,
  metadataDiff,
  handleVoidedTx,
  handleTxFirstBlock,
  handleNcExecVoided,
  updateLastSyncedEvent,
  fetchInitialState,
  handleUnvoidedTx,
  handleReorgStarted,
  handleTokenCreated,
  checkForMissedEvents,
} from '../services';
import {
  hasNextChange,
  metadataChanged,
  vertexAccepted,
  invalidPeerId,
  invalidStreamId,
  invalidNetwork,
  websocketDisconnected,
  voided,
  unchanged,
  vertexRemoved,
  reorgStarted,
  tokenCreated,
  hasNewEvents,
} from '../guards';
import { METADATA_DIFF_EVENT_TYPES } from '../services';
import {
  storeInitialState,
  storeMetadataChanges,
  shiftMetadataChange,
  startStream,
  clearSocket,
  storeEvent,
  sendAck,
  increaseRetry,
  logEventError,
  updateCache,
  startHealthcheckPing,
  stopHealthcheckPing,
  sendMonitoringConnected,
  sendMonitoringDisconnected,
  sendMonitoringEventReceived,
  sendMonitoringReconnecting,
  alertStuckProcessing,
} from '../actions';
import { BACKOFF_DELAYED_RECONNECT, ACK_TIMEOUT, STUCK_PROCESSING_TIMEOUT } from '../delays';
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
  handlingVertexRemoved: 'handlingVertexRemoved',
  handlingVoidedTx: 'handlingVoidedTx',
  handlingUnvoidedTx: 'handlingUnvoidedTx',
  handlingFirstBlock: 'handlingFirstBlock',
  handlingNcExecVoided: 'handlingNcExecVoided',
  handlingReorgStarted: 'handlingReorgStarted',
  handlingTokenCreated: 'handlingTokenCreated',
  checkingForMissedEvents: 'checkingForMissedEvents',
};

const { TX_CACHE_SIZE } = getConfig();

export const SyncMachine = Machine<Context, any, Event>({
  id: 'SyncMachine',
  initial: SYNC_MACHINE_STATES.INITIALIZING,
  context: {
    socket: null,
    healthcheck: null,
    monitoring: null,
    retryAttempt: 0,
    event: null,
    initialEventId: null,
    txCache: null,
  },
  states: {
    [SYNC_MACHINE_STATES.INITIALIZING]: {
      entry: assign({
        txCache: () => new LRU(TX_CACHE_SIZE),
        healthcheck: () => spawn(HealthCheckActor),
        monitoring: () => spawn(MonitoringActor),
      }),
      invoke: {
        src: 'fetchInitialState',
        onDone: {
          actions: ['storeInitialState'],
          target: SYNC_MACHINE_STATES.CONNECTING,
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
          target: SYNC_MACHINE_STATES.RECONNECTING,
        }, {
          target: SYNC_MACHINE_STATES.CONNECTED,
        }],
      },
    },
    [SYNC_MACHINE_STATES.RECONNECTING]: {
      onEntry: [
        'clearSocket',
        'increaseRetry',
        'stopHealthcheckPing',
        'sendMonitoringReconnecting',
        'sendMonitoringDisconnected',
      ],
      after: {
        BACKOFF_DELAYED_RECONNECT: SYNC_MACHINE_STATES.CONNECTING,
      },
    },
    [SYNC_MACHINE_STATES.CONNECTED]: {
      id: SYNC_MACHINE_STATES.CONNECTED,
      initial: CONNECTED_STATES.idle,
      entry: ['startStream', 'startHealthcheckPing', 'sendMonitoringConnected'],
      states: {
        [CONNECTED_STATES.idle]: {
          id: CONNECTED_STATES.idle,
          after: {
            ACK_TIMEOUT: {
              target: CONNECTED_STATES.checkingForMissedEvents,
            },
          },
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
              actions: ['storeEvent', 'sendAck', 'sendMonitoringEventReceived'],
              cond: 'unchanged',
              target: CONNECTED_STATES.idle,
            }, {
              actions: ['storeEvent', 'sendMonitoringEventReceived'],
              cond: 'metadataChanged',
              target: CONNECTED_STATES.handlingMetadataChanged,
            }, {
              actions: ['storeEvent', 'sendAck', 'sendMonitoringEventReceived'],
              /* If the transaction is already voided and is not
               * VERTEX_METADATA_CHANGED, we should ignore it.
               */
              cond: 'voided',
              target: CONNECTED_STATES.idle,
            }, {
              actions: ['storeEvent', 'sendMonitoringEventReceived'],
              cond: 'vertexRemoved',
              target: CONNECTED_STATES.handlingVertexRemoved,
            }, {
              actions: ['storeEvent', 'sendMonitoringEventReceived'],
              cond: 'vertexAccepted',
              target: CONNECTED_STATES.handlingVertexAccepted,
            }, {
              actions: ['storeEvent', 'sendMonitoringEventReceived'],
              cond: 'reorgStarted',
              target: CONNECTED_STATES.handlingReorgStarted,
            }, {
              actions: ['storeEvent', 'sendMonitoringEventReceived'],
              cond: 'tokenCreated',
              target: CONNECTED_STATES.handlingTokenCreated,
            }, {
              actions: ['storeEvent', 'sendMonitoringEventReceived'],
              target: CONNECTED_STATES.handlingUnhandledEvent,
            }],
          },
        },
        [CONNECTED_STATES.handlingUnhandledEvent]: {
          id: CONNECTED_STATES.handlingUnhandledEvent,
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
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
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
          states: {
            detectingDiff: {
              invoke: {
                src: 'metadataDiff',
                onDone: {
                  target: 'dispatching',
                  actions: ['storeMetadataChanges'],
                },
                onError: `#${SYNC_MACHINE_STATES.ERROR}`,
              },
            },
            dispatching: {
              id: 'dispatchingMetadataChange',
              always: [
                { target: `#${CONNECTED_STATES.handlingVoidedTx}`, cond: { type: 'hasNextChange', changeType: METADATA_DIFF_EVENT_TYPES.TX_VOIDED }, actions: ['shiftMetadataChange'] },
                { target: `#${CONNECTED_STATES.handlingUnvoidedTx}`, cond: { type: 'hasNextChange', changeType: METADATA_DIFF_EVENT_TYPES.TX_UNVOIDED }, actions: ['shiftMetadataChange'] },
                { target: `#${CONNECTED_STATES.handlingVertexAccepted}`, cond: { type: 'hasNextChange', changeType: METADATA_DIFF_EVENT_TYPES.TX_NEW }, actions: ['shiftMetadataChange'] },
                { target: `#${CONNECTED_STATES.handlingFirstBlock}`, cond: { type: 'hasNextChange', changeType: METADATA_DIFF_EVENT_TYPES.TX_FIRST_BLOCK }, actions: ['shiftMetadataChange'] },
                { target: `#${CONNECTED_STATES.handlingNcExecVoided}`, cond: { type: 'hasNextChange', changeType: METADATA_DIFF_EVENT_TYPES.NC_EXEC_VOIDED }, actions: ['shiftMetadataChange'] },
                // Queue empty or unrecognized (including IGNORE) → done
                { target: `#${CONNECTED_STATES.handlingUnhandledEvent}` },
              ],
            },
          },
        },
        // We have the unchanged guard, so it's guaranteed that this is a new tx
        [CONNECTED_STATES.handlingVertexAccepted]: {
          id: CONNECTED_STATES.handlingVertexAccepted,
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
          invoke: {
            src: 'handleVertexAccepted',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: '#dispatchingMetadataChange',
              actions: ['storeEvent', 'updateCache'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingVertexRemoved]: {
          id: CONNECTED_STATES.handlingVertexRemoved,
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
          invoke: {
            src: 'handleVertexRemoved',
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
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
          invoke: {
            src: 'handleVoidedTx',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: '#dispatchingMetadataChange',
              actions: ['storeEvent', 'updateCache'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingUnvoidedTx]: {
          id: CONNECTED_STATES.handlingUnvoidedTx,
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
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
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
          invoke: {
            src: 'handleTxFirstBlock',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: '#dispatchingMetadataChange',
              actions: ['storeEvent', 'updateCache'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingNcExecVoided]: {
          id: CONNECTED_STATES.handlingNcExecVoided,
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
          invoke: {
            src: 'handleNcExecVoided',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: '#dispatchingMetadataChange',
              actions: ['storeEvent', 'updateCache'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingReorgStarted]: {
          id: CONNECTED_STATES.handlingReorgStarted,
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
          invoke: {
            src: 'handleReorgStarted',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
              actions: ['sendAck', 'storeEvent'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.handlingTokenCreated]: {
          id: CONNECTED_STATES.handlingTokenCreated,
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
          invoke: {
            src: 'handleTokenCreated',
            data: (_context: Context, event: Event) => event,
            onDone: {
              target: 'idle',
              actions: ['sendAck', 'storeEvent'],
            },
            onError: `#${SYNC_MACHINE_STATES.ERROR}`,
          },
        },
        [CONNECTED_STATES.checkingForMissedEvents]: {
          id: CONNECTED_STATES.checkingForMissedEvents,
          after: {
            STUCK_PROCESSING_TIMEOUT: {
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
              actions: ['alertStuckProcessing'],
            },
          },
          invoke: {
            src: 'checkForMissedEvents',
            onDone: [{
              cond: 'hasNewEvents',
              target: `#SyncMachine.${SYNC_MACHINE_STATES.RECONNECTING}`,
            }, {
              target: CONNECTED_STATES.idle,
            }],
            onError: {
              // Critical failure - we cannot verify event integrity
              target: `#${SYNC_MACHINE_STATES.ERROR}`,
            },
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
      onEntry: ['logEventError', 'stopHealthcheckPing', 'sendMonitoringDisconnected'],
    },
  },
}, {
  services: {
    handleVertexAccepted,
    handleVertexRemoved,
    handleVoidedTx,
    handleTxFirstBlock,
    handleNcExecVoided,
    handleUnvoidedTx,
    handleReorgStarted,
    handleTokenCreated,
    fetchInitialState,
    metadataDiff,
    updateLastSyncedEvent,
    checkForMissedEvents,
  },
  guards: {
    hasNextChange,
    metadataChanged,
    vertexAccepted,
    invalidPeerId,
    invalidStreamId,
    invalidNetwork,
    websocketDisconnected,
    voided,
    unchanged,
    vertexRemoved,
    reorgStarted,
    tokenCreated,
    hasNewEvents,
  },
  delays: { BACKOFF_DELAYED_RECONNECT, ACK_TIMEOUT, STUCK_PROCESSING_TIMEOUT },
  actions: {
    storeInitialState,
    storeMetadataChanges,
    shiftMetadataChange,
    startStream,
    clearSocket,
    storeEvent,
    sendAck,
    increaseRetry,
    logEventError,
    updateCache,
    startHealthcheckPing,
    stopHealthcheckPing,
    sendMonitoringConnected,
    sendMonitoringDisconnected,
    sendMonitoringEventReceived,
    sendMonitoringReconnecting,
    alertStuckProcessing,
  },
});

export default SyncMachine;
