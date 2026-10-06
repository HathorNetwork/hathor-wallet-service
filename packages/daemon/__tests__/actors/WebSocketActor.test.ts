/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import WebSocketActor from '../../src/actors/WebSocketActor';
import logger from '../../src/logger';
import alphaV4ShieldedVertexEvent from '../__fixtures__/alpha-v4-shielded-vertex-event';

// Never settles, so the test can observe the actor between the alert and the
// failure that follows it (which would otherwise end the test process).
const mockAddAlert = jest.fn(() => new Promise<void>(() => {}));
jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: (...args: unknown[]) => mockAddAlert(...(args as [])),
}));

// The last socket created by the actor, so the tests can fire its close event.
let mockSocket: any;

jest.mock('ws', () => ({
  WebSocket: jest.fn().mockImplementation(() => {
    mockSocket = {
      on: jest.fn(),
      send: jest.fn(),
      ping: jest.fn(),
      terminate: jest.fn(),
      close: jest.fn(),
    };
    return mockSocket;
  }),
}));

jest.mock('../../src/utils', () => ({
  ...jest.requireActual('../../src/utils'),
  getFullnodeWsUrl: () => 'ws://fullnode/v1a/event_ws',
}));

describe('WebSocketActor', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    infoSpy = jest.spyOn(logger, 'info');
  });

  afterEach(() => {
    infoSpy.mockRestore();
    jest.useRealTimers();
  });

  it('should log the close code and reason when the other side closes the socket', () => {
    const callback = jest.fn();
    WebSocketActor(callback, jest.fn());

    mockSocket.onclose({ code: 1006, reason: '' });

    expect(infoSpy).toHaveBeenCalledWith('WebSocket closed with code 1006');
    expect(callback).toHaveBeenCalledWith({
      type: 'WEBSOCKET_EVENT',
      event: { type: 'DISCONNECTED' },
    });
  });

  it('should log that the daemon closed the socket when the actor is stopped', () => {
    const stopActor = WebSocketActor(jest.fn(), jest.fn());

    stopActor();
    expect(mockSocket.close).toHaveBeenCalledTimes(1);

    mockSocket.onclose({ code: 1000, reason: 'bye' });

    expect(infoSpy).toHaveBeenCalledWith('WebSocket closed with code 1000, reason: bye, closed by daemon');
  });

  describe('an event the schema rejects', () => {
    const message = (event: unknown) => ({ data: Buffer.from(JSON.stringify(event)) });
    const valid = () => JSON.parse(JSON.stringify(alphaV4ShieldedVertexEvent));

    beforeEach(() => mockAddAlert.mockClear());

    it('pages with a CRITICAL alert naming the event and the failing field', () => {
      WebSocketActor(jest.fn(), jest.fn());
      const bad = valid();
      bad.event.data.shielded_outputs[0].commitment = 'not hex';

      mockSocket.onmessage(message(bad));

      expect(mockAddAlert).toHaveBeenCalledTimes(1);
      const [title, , severity, metadata] = (mockAddAlert.mock.calls[0] as unknown) as unknown[];
      expect(title).toBe('Fullnode event failed schema validation');
      expect(severity).toBe('critical');
      expect(metadata).toMatchObject({
        event_id: bad.event.id,
        tx_id: bad.event.data.hash,
        issues: expect.arrayContaining([expect.stringContaining('event.data.shielded_outputs.0.commitment')]),
      });
    });

    it('hands neither that event nor any later one to the machine', () => {
      const callback = jest.fn();
      WebSocketActor(callback, jest.fn());
      const bad = valid();
      bad.event.data.shielded_outputs[0].commitment = 'not hex';

      mockSocket.onmessage(message(bad));
      // A later, valid event must not be processed past the one that failed.
      mockSocket.onmessage(message(valid()));

      expect(callback).not.toHaveBeenCalled();
      expect(mockAddAlert).toHaveBeenCalledTimes(1);
    });

    it('hands a valid event to the machine', () => {
      const callback = jest.fn();
      WebSocketActor(callback, jest.fn());

      mockSocket.onmessage(message(valid()));

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ type: 'FULLNODE_EVENT' }));
      expect(mockAddAlert).not.toHaveBeenCalled();
    });
  });
});
