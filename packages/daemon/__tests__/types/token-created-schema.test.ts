/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { bigIntUtils } from '@hathor/wallet-lib';
import { FullNodeEventSchema } from '../../src/types';

/**
 * Events arrive as JSON parsed by `bigIntUtils.JSONBigInt.parse` BEFORE Zod
 * validation (see WebSocketActor). Any integer above Number.MAX_SAFE_INTEGER is
 * returned as a BigInt, so `TOKEN_CREATED.initial_amount` must accept bigint —
 * a bare `z.number()` would reject large token supplies and fail the whole
 * event, so the token would never be inserted and `total_supply` never set.
 */
describe('TOKEN_CREATED initial_amount schema', () => {
  const buildEventJson = (initialAmount: string): string => `{
    "stream_id": "stream-id",
    "peer_id": "peer-id",
    "network": "mainnet",
    "type": "FULLNODE_EVENT",
    "latest_event_id": 1,
    "event": {
      "id": 1,
      "timestamp": 1700000000,
      "type": "TOKEN_CREATED",
      "data": {
        "token_uid": "0000token",
        "nc_exec_info": null,
        "token_name": "CreationToken",
        "token_symbol": "CRT",
        "token_version": 1,
        "initial_amount": ${initialAmount}
      },
      "group_id": null
    }
  }`;

  it('accepts an initial_amount above Number.MAX_SAFE_INTEGER (parsed as bigint)', () => {
    const parsed = bigIntUtils.JSONBigInt.parse(buildEventJson('9223372036854775807')); // 2^63 - 1
    const result = FullNodeEventSchema.safeParse(parsed);

    expect(result.success).toBe(true);
    if (result.success) {
      const { data } = (result.data as { event: { data: { initial_amount: unknown } } }).event;
      expect(typeof data.initial_amount).toBe('bigint');
      expect(data.initial_amount).toBe(9223372036854775807n);
    }
  });

  it('still accepts a small numeric initial_amount', () => {
    const parsed = bigIntUtils.JSONBigInt.parse(buildEventJson('12345'));
    const result = FullNodeEventSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});
