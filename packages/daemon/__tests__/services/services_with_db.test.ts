/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as db from '../../src/db';
import { handleVoidedTx } from '../../src/services';
import { LRU } from '../../src/utils';

/**
 * @jest-environment node
 */

describe('handleVoidedTx (db)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle transactions with an empty list of inputs', async () => {
    const voidTxSpy = jest.spyOn(db, 'voidTransaction');
    voidTxSpy.mockResolvedValue();

    const context = {
      socket: expect.any(Object),
      healthcheck: expect.any(Object),
      retryAttempt: expect.any(Number),
      initialEventId: expect.any(Number),
      txCache: expect.any(LRU),
      event: {
        stream_id: 'stream-id',
        peer_id: 'peer_id',
        network: 'testnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: 4,
        event: {
          id: 5,
          data: {
            hash: 'random-hash',
            outputs: [],
            inputs: [],
            tokens: [],
          },
        },
      },
    };

    const mysql = await db.getDbConnection();
    const lastEvent = await db.getLastSyncedEvent(mysql);

    await expect(handleVoidedTx(context as any)).resolves.not.toThrow();
    expect(db.voidTransaction).toHaveBeenCalledWith(
      expect.any(Object),
      'random-hash',
      expect.any(Object),
    );
    expect(lastEvent).toStrictEqual({
      id: expect.any(Number),
      last_event_id: 5,
      updated_at: expect.any(String),
    });
  });
});
