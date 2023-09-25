/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @jest-environment node
 */

import { interpret } from 'xstate';
import { SyncMachine, TxCache } from '../../src/machines';
import EventFixtures from '../__fixtures__/events';
import { FullNodeEvent } from '../../src/machines/types';
import { hashTxData } from '../../src/utils';

const { VERTEX_METADATA_CHANGED } = EventFixtures;

beforeAll(async () => {
  jest.clearAllMocks();
});

describe('WebSocket connection', () => {
  it.skip('should start at CONNECTING and then transition to CONNECTED.idle if the websocket is successfully initialized', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      services: {
        initializeWebSocket: async (_, _event) => {
          return Promise.resolve();
        },
        checkPeerId: async (_, _event) => {
          return Promise.resolve();
        },
      },
    });

    let currentState = MockedFetchMachine.initialState;

    expect(currentState.matches('CONNECTING')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'CONNECTED', }});

    expect(currentState.matches('CONNECTED.validateNetwork')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'done.invoke.websocket.CONNECTED.validateNetwork:invocation[0]' });

    expect(currentState.matches('CONNECTED.idle')).toBeTruthy();
  });

  it.skip('should transition to RECONNECTING if the websocket fails to initialize', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      delays: {
        RETRY_BACKOFF_INCREASE: 100,
      },
    });

    let currentState = MockedFetchMachine.initialState;

    expect(currentState.matches('CONNECTING')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'DISCONNECTED', }});

    expect(currentState.matches('RECONNECTING')).toBeTruthy();
  });

  it.skip('should transition to CONNECTING to reconnect after a failure in the initial connection', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      services: {
        initializeWebSocket: async (_, _event) => {
          return Promise.reject();
        },
      },
      delays: {
        RETRY_BACKOFF_INCREASE: 1,
      },
    });

    let currentState = MockedFetchMachine.initialState;

    expect(currentState.matches('CONNECTING')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'DISCONNECTED', }});

    expect(currentState.matches('RECONNECTING')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'xstate.after(RETRY_BACKOFF_INCREASE)#websocket.RECONNECTING' });

    expect(currentState.matches('CONNECTING')).toBeTruthy();
  });

  it.skip('should transition to RECONNECTING to reconnect after a failure', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      services: {
        initializeWebSocket: async (_, _event) => {
          return Promise.resolve();
        },
        checkPeerId: async (_, _event) => {
          return Promise.resolve();
        },
      },
      delays: {
        RETRY_BACKOFF_INCREASE: 1,
      },
    });

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'CONNECTED', }});

    expect(currentState.matches('CONNECTED.validateNetwork')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'done.invoke.websocket.CONNECTED.validateNetwork:invocation[0]' });

    expect(currentState.matches('CONNECTED.idle')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: 'WEBSOCKET_EVENT',
      event: {
        type: 'DISCONNECTED',
      },
    });

    expect(currentState.matches('RECONNECTING')).toBeTruthy();
  });
});

describe('Validations', () => {
  it.skip('should validate the network before starting the stream', () => {
    const MockedFetchMachine = SyncMachine.withConfig({});

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'CONNECTED', }});

    expect(currentState.matches('CONNECTED.validateNetwork')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'done.invoke.websocket.CONNECTED.validateNetwork:invocation[0]' });

    expect(currentState.matches('CONNECTED.idle')).toBeTruthy();
  });

  it.skip('should transition to ERROR final state if the network is incorrect', () => {
    const MockedFetchMachine = SyncMachine.withConfig({});

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'CONNECTED', }});

    expect(currentState.matches('CONNECTED.validateNetwork')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'error.platform.websocket.CONNECTED.validateNetwork:invocation[0]' });

    expect(currentState.matches('ERROR')).toBeTruthy();
  });

  it.skip('should validate the peerid on every message', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      guards: {
        invalidPeerId: (_event, _context) => {
          return true;
        },
      }
    });

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'CONNECTED', }});

    expect(currentState.matches('CONNECTED.validateNetwork')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'done.invoke.websocket.CONNECTED.validateNetwork:invocation[0]' });

    expect(currentState.matches('CONNECTED.idle')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: 'FULLNODE_EVENT',
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches('ERROR')).toBe(true);
  });
});

describe('Event handling', () => {
  beforeEach(() => {
    TxCache.clear();
  });

  it.skip('should ignore already processed transactions', () => {
    const MockedFetchMachine = SyncMachine.withConfig({
      services: {
        initializeWebSocket: async (_, _event) => {
          return Promise.resolve();
        },
        validateNetwork: async (_, _event) => {
          return Promise.resolve();
        },
      },
      guards: {
        ...SyncMachine.options.guards,
        invalidPeerId: (_event, _context) => {
          return false;
        },
      }
    });

    const hashedTx = hashTxData(VERTEX_METADATA_CHANGED.event.data.metadata);
    TxCache.set(VERTEX_METADATA_CHANGED.event.data.hash, hashedTx);

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'CONNECTED', }});

    expect(currentState.matches('CONNECTED.validateNetwork')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'done.invoke.websocket.CONNECTED.validateNetwork:invocation[0]' });

    expect(currentState.matches('CONNECTED.idle')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: 'FULLNODE_EVENT',
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches('CONNECTED.idle')).toBe(true);
    // @ts-ignore
    expect(currentState.context.event.event.id).toStrictEqual(VERTEX_METADATA_CHANGED.event.id);

    TxCache.clear();

    currentState = MockedFetchMachine.transition(currentState, {
      type: 'FULLNODE_EVENT',
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches('CONNECTED.handlingMetadataChanged')).toBe(true);
    // @ts-ignore
    expect(currentState.context.event.event.id).toStrictEqual(VERTEX_METADATA_CHANGED.event.id);
  });

  it.skip('should transition to handlingVoidedTx if TX_VOIDED action is received from diff detector', () => {
    TxCache.clear();

    const MockedFetchMachine = SyncMachine.withConfig({});

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'CONNECTED', }});

    expect(currentState.matches('CONNECTED.validateNetwork')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'done.invoke.websocket.CONNECTED.validateNetwork:invocation[0]' });

    expect(currentState.matches('CONNECTED.idle')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: 'FULLNODE_EVENT',
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches('CONNECTED.handlingMetadataChanged.detectingDiff')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: 'METADATA_DECIDED',
      event: {
        type: 'TX_VOIDED',
        originalEvent: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
      }
    });

    expect(currentState.matches('CONNECTED.handlingVoidedTx')).toBeTruthy();
  });

  it.skip('should transition to handlingNewTx if TX_NEW action is received from diff detector', () => {
    const MockedFetchMachine = SyncMachine.withConfig({});

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'CONNECTED', }});

    expect(currentState.matches('CONNECTED.validateNetwork')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'done.invoke.websocket.CONNECTED.validateNetwork:invocation[0]' });

    expect(currentState.matches('CONNECTED.idle')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: 'FULLNODE_EVENT',
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches('CONNECTED.handlingMetadataChanged.detectingDiff')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: 'METADATA_DECIDED',
      event: {
        type: 'TX_NEW',
        originalEvent: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
      }
    });

    expect(currentState.matches('CONNECTED.handlingNewTx')).toBeTruthy();
  });

  it.skip('should transition to handlingFirstBlock if TX_FIRST_BLOCK action is received from diff detector', () => {
    TxCache.clear();

    const MockedFetchMachine = SyncMachine.withConfig({});

    let currentState = MockedFetchMachine.initialState;

    currentState = MockedFetchMachine.transition(currentState, { type: 'WEBSOCKET_EVENT', event: { type: 'CONNECTED', }});

    expect(currentState.matches('CONNECTED.validateNetwork')).toBeTruthy();

    // @ts-ignore
    currentState = MockedFetchMachine.transition(currentState, { type: 'done.invoke.websocket.CONNECTED.validateNetwork:invocation[0]' });

    expect(currentState.matches('CONNECTED.idle')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      type: 'FULLNODE_EVENT',
      event: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
    });

    expect(currentState.matches('CONNECTED.handlingMetadataChanged.detectingDiff')).toBeTruthy();

    currentState = MockedFetchMachine.transition(currentState, {
      // @ts-ignore
      type: 'METADATA_DECIDED',
      event: {
        type: 'TX_FIRST_BLOCK',
        originalEvent: VERTEX_METADATA_CHANGED as unknown as FullNodeEvent,
      }
    });

    expect(currentState.matches('CONNECTED.handlingFirstBlock')).toBeTruthy();
  });
});
