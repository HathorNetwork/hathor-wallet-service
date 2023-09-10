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
import { SyncMachine } from '../../src/machines';

beforeAll(async () => {
  jest.clearAllMocks();
});

describe('WebSocket connection', () => {
  test('SyncMachine should start at CONNECTING and then transition to CONNECTED.idle if the websocket is successfully initialized', (done) => {
    const MockedFetchMachine = SyncMachine.withConfig({
      services: {
        initializeWebSocket: async (_, _event) => {
          return Promise.resolve();
        },
      },
    });

    const syncMachine = interpret(MockedFetchMachine);

    let connecting = false;
    syncMachine.onTransition((state) => {
      if (!connecting && state.matches('CONNECTING')) {
        connecting = true;
      }
      if (connecting && state.matches('CONNECTED.idle')) {
        syncMachine.stop();
        done();
      }
    });

    syncMachine.start();
  });

  test('SyncMachine should transition to RECONNECTING if the websocket fails to initialize', (done) => {
    const MockedFetchMachine = SyncMachine.withConfig({
      services: {
        initializeWebSocket: async (_, _event) => {
          return Promise.reject();
        },
      },
      delays: {
        RETRY_BACKOFF_INCREASE: 100,
      },
    });

    const syncMachine = interpret(MockedFetchMachine);

    syncMachine.onTransition((state) => {
      if (state.matches('RECONNECTING')) {
        syncMachine.stop();
        done();
      }
    });

    syncMachine.start();
  });

  test('SyncMachine should transition to CONNECTING to reconnect after a failure', (done) => {
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

    const syncMachine = interpret(MockedFetchMachine);

    let isReconnecting = false;
    syncMachine.onTransition((state) => {
      if (state.matches('RECONNECTING')) {
        isReconnecting = true;
      }

      if (isReconnecting && state.matches('CONNECTING')) {
        syncMachine.stop();
        done();
      }
    });

    syncMachine.start();
  });
});
