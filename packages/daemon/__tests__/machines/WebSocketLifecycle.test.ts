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
import { SyncMachine, SYNC_MACHINE_STATES } from '../../src/machines';
import { EventTypes } from '../../src/types';

interface MockSocket {
  callback: (event: any) => void;
  stopped: boolean;
}

// Every spawned websocket actor is recorded here, so the tests can check which
// ones were stopped and make a stale one emit events.
const mockSockets: MockSocket[] = [];

jest.mock('../../src/actors', () => {
  const actual = jest.requireActual('../../src/actors');

  return {
    ...actual,
    WebSocketActor: (callback: (event: any) => void) => {
      const socket: MockSocket = { callback, stopped: false };
      mockSockets.push(socket);
      return () => {
        socket.stopped = true;
      };
    },
    HealthCheckActor: () => () => {},
    MonitoringActor: () => () => {},
  };
});

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const connectedEvent = { type: EventTypes.WEBSOCKET_EVENT, event: { type: 'CONNECTED' } };
const disconnectedEvent = { type: EventTypes.WEBSOCKET_EVENT, event: { type: 'DISCONNECTED' } };

describe('websocket actor lifecycle', () => {
  beforeEach(() => {
    mockSockets.length = 0;
  });

  const startMachine = () => {
    const checkForMissedEvents = jest.fn()
      .mockResolvedValueOnce({ hasNewEvents: true })
      .mockResolvedValue({ hasNewEvents: false });

    const machine = SyncMachine.withConfig({
      services: {
        fetchInitialState: async () => ({ lastEventId: 1, rewardMinBlocks: 1 }),
        checkForMissedEvents,
      },
      delays: {
        BACKOFF_DELAYED_RECONNECT: 10,
        ACK_TIMEOUT: 10,
      },
    });

    return interpret(machine).start();
  };

  it('should stop the previous websocket actor when the daemon decides to reconnect', async () => {
    const service = startMachine();

    try {
      await waitFor(() => mockSockets.length === 1);
      mockSockets[0].callback(connectedEvent);

      // The first missed-events check reports new events, so the daemon reconnects
      // on its own while the first socket is still open.
      await waitFor(() => mockSockets.length === 2);

      expect(mockSockets[0].stopped).toBe(true);
      expect(mockSockets[1].stopped).toBe(false);
    } finally {
      service.stop();
    }
  });

  it('should ignore a DISCONNECTED event sent by a previous websocket actor', async () => {
    const service = startMachine();

    try {
      await waitFor(() => mockSockets.length === 1);
      mockSockets[0].callback(connectedEvent);

      await waitFor(() => mockSockets.length === 2);
      mockSockets[1].callback(connectedEvent);
      await waitFor(() => service.state.matches(SYNC_MACHINE_STATES.CONNECTED));

      // The stale socket closes later on (e.g. the load balancer ends it). This must
      // not take down the live connection.
      mockSockets[0].callback(disconnectedEvent);

      expect(service.state.matches(SYNC_MACHINE_STATES.CONNECTED)).toBe(true);
      expect(mockSockets).toHaveLength(2);
    } finally {
      service.stop();
    }
  });
});
