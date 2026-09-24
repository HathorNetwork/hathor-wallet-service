/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import WebSocketActor from '../../src/actors/WebSocketActor';
import logger from '../../src/logger';

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
});
