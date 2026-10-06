/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import EventFixtures from '../__fixtures__/events';
import { TxEventDataSchema, isMalformedShieldedOutput } from '../../src/types/event';

const { VERTEX_WITH_SHIELDED } = EventFixtures;

describe('VERTEX_WITH_SHIELDED fixture', () => {
  it('parses event.data against TxEventDataSchema', () => {
    const parsed = TxEventDataSchema.parse(VERTEX_WITH_SHIELDED.event.data);

    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.shielded_outputs).toHaveLength(1);

    const shielded = parsed.shielded_outputs[0];
    expect(isMalformedShieldedOutput(shielded)).toBe(false);
    expect(shielded.mode).toBe(1);
    if (!isMalformedShieldedOutput(shielded) && shielded.mode === 1) {
      expect(shielded.token_data).toBe(1);
      expect(shielded.commitment).toBe('02'.repeat(33));
      expect(shielded.range_proof).toBe(Buffer.alloc(64, 0x03).toString('base64'));
      expect(shielded.script).toBe(Buffer.alloc(20, 0x04).toString('base64'));
      expect(shielded.ephemeral_pubkey).toBe('05'.repeat(33));
      expect(shielded.decoded?.address).toBe('WShieldedAddress1');
    }
  });

  it('defaults shielded_outputs to [] when omitted', () => {
    const { shielded_outputs, ...rest } = VERTEX_WITH_SHIELDED.event.data;
    void shielded_outputs;

    const parsed = TxEventDataSchema.parse(rest);
    expect(parsed.shielded_outputs).toEqual([]);
  });
});
