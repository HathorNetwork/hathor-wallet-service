/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { FullNodeEventSchema } from '../../src/types/event';
import { buildErrorLogMessage, formatErrorForLog, registerProcessErrorHandlers } from '../../src/utils/error';

describe('error utils', () => {
  it('should serialize nested zod errors onto a single line', () => {
    const parseResult = FullNodeEventSchema.safeParse({
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

    expect(parseResult.success).toBe(false);

    if (parseResult.success) {
      throw new Error('Expected invalid payload to fail schema validation');
    }

    const message = formatErrorForLog(parseResult.error);

    expect(message).toContain('Zod validation failed:');
    expect(message).toContain('event.data.inputs.0.spent_output');
    expect(message).not.toContain('\n');
  });

  it('should serialize stack traces onto a single line', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at first (file.ts:1:1)\n    at second (file.ts:2:2)';

    expect(buildErrorLogMessage('Unhandled exception', error)).toBe(
      'Unhandled exception: Error: boom | at first (file.ts:1:1) | at second (file.ts:2:2)'
    );
  });

  it('should register fatal handlers that log one-line messages', () => {
    const handlers: Partial<Record<'uncaughtException' | 'unhandledRejection', (reason: unknown) => void>> = {};
    const processLike = {
      on: jest.fn((event: 'uncaughtException' | 'unhandledRejection', handler: (reason: unknown) => void) => {
        handlers[event] = handler;
      }),
    };
    const logger = { error: jest.fn() };
    const exit = jest.fn();

    registerProcessErrorHandlers(processLike, logger, exit);

    const error = new Error('fatal');
    error.stack = 'Error: fatal\n    at main (index.ts:1:1)';

    handlers.uncaughtException?.(error);
    handlers.unhandledRejection?.('bad\nnews');

    expect(processLike.on).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenNthCalledWith(1, 'Unhandled exception: Error: fatal | at main (index.ts:1:1)');
    expect(logger.error).toHaveBeenNthCalledWith(2, 'Unhandled promise rejection: bad | news');
    expect(exit).toHaveBeenNthCalledWith(1, 1);
    expect(exit).toHaveBeenNthCalledWith(2, 1);
  });
});