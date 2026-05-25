/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ZodError } from 'zod';
import WebSocketActor from '../../src/actors/WebSocketActor';
import logger from '../../src/logger';

type MockSocketInstance = {
  url: string;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: (error: unknown) => void;
  onclose?: () => void;
  close: jest.Mock;
  ping: jest.Mock;
  send: jest.Mock;
  terminate: jest.Mock;
  on: jest.Mock;
};

const socketInstances: MockSocketInstance[] = [];

jest.mock('../../src/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('../../src/utils', () => ({
  getFullnodeWsUrl: jest.fn(() => 'ws://fullnode.example/v1a/event_ws'),
}));

jest.mock('ws', () => ({
  WebSocket: class {
    public onopen?: () => void;
    public onmessage?: (event: { data: string }) => void;
    public onerror?: (error: unknown) => void;
    public onclose?: () => void;

    public readonly close = jest.fn(() => {
      this.onclose?.();
    });
    public readonly ping = jest.fn();
    public readonly send = jest.fn();
    public readonly terminate = jest.fn();
    public readonly on = jest.fn();

    constructor(public readonly url: string) {
      socketInstances.push(this as unknown as MockSocketInstance);
    }
  },
}));

describe('WebSocketActor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    socketInstances.length = 0;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('should log the raw payload and throw the original ZodError on invalid events', () => {
    const callback = jest.fn();
    const receive = jest.fn();

    WebSocketActor(callback, receive);

    const socket = socketInstances[0];
    const invalidPayload = JSON.stringify({
      type: 'EVENT',
      peer_id: 'peer-id',
      network: 'testnet',
      event: {
        id: 1,
        timestamp: 1,
        type: 'VERTEX_METADATA_CHANGED',
        data: {
          hash: 'hash',
          nonce: 1,
          timestamp: 1,
          signal_bits: 0,
          version: 1,
          weight: 1,
          inputs: [
            {
              tx_id: 'tx-id',
              index: 0,
              spent_output: {
                type: 'shielded',
              },
            },
          ],
          outputs: [],
          parents: [],
          tokens: [],
          token_name: null,
          token_symbol: null,
          metadata: {
            hash: 'hash',
            voided_by: [],
            first_block: null,
            height: 1,
          },
        },
      },
    });

    let thrownError: unknown;

    try {
      socket.onmessage?.({ data: invalidPayload });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(ZodError);
    expect(logger.error).toHaveBeenCalledWith(`Could not parse event: ${invalidPayload}`);
  });

  it('should log websocket errors on a single line', () => {
    const callback = jest.fn();
    const receive = jest.fn();

    WebSocketActor(callback, receive);

    const socket = socketInstances[0];
    const error = new Error('socket failure');
    error.stack = 'Error: socket failure\n    at connect (WebSocketActor.ts:1:1)';

    socket.onerror?.(error);

    expect(logger.error).toHaveBeenCalledWith(
      'Socket errored: Error: socket failure | at connect (WebSocketActor.ts:1:1)'
    );
  });
});