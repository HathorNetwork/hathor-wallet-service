/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  ShieldedOutputSchema,
  SpentOutputSchema,
  TxEventDataWithoutMetaSchema,
} from '../../src/types/event';

describe('shielded event schemas', () => {
  describe('ShieldedOutputSchema', () => {
    it('accepts a mode=1 AmountShielded entry with token_data', () => {
      const v = ShieldedOutputSchema.parse({
        mode: 1,
        commitment: 'aa'.repeat(33),
        range_proof: 'bb'.repeat(64),
        script: 'cc'.repeat(20),
        ephemeral_pubkey: 'dd'.repeat(33),
        token_data: 1,
        decoded: { address: 'WT4nABC' },
      });
      expect(v.mode).toBe(1);
      expect(v.token_data).toBe(1);
    });

    it('accepts a mode=2 FullyShielded entry with asset_commitment and surjection_proof', () => {
      const v = ShieldedOutputSchema.parse({
        mode: 2,
        commitment: 'aa'.repeat(33),
        range_proof: 'bb'.repeat(64),
        script: 'cc'.repeat(20),
        ephemeral_pubkey: 'dd'.repeat(33),
        asset_commitment: 'ee'.repeat(33),
        surjection_proof: 'ff'.repeat(64),
        decoded: { address: 'WT4nXYZ' },
      });
      expect(v.mode).toBe(2);
      expect(v.asset_commitment).toBe('ee'.repeat(33));
      expect(v.surjection_proof).toBe('ff'.repeat(64));
    });

    it('rejects an unknown mode (mode=9)', () => {
      expect(() =>
        ShieldedOutputSchema.parse({
          mode: 9,
          commitment: 'aa'.repeat(33),
          range_proof: 'bb'.repeat(64),
          script: 'cc'.repeat(20),
          ephemeral_pubkey: 'dd'.repeat(33),
          decoded: { address: 'WT4n' },
        })
      ).toThrow();
    });
  });

  describe('SpentOutputSchema', () => {
    it('accepts transparent with explicit mode=0', () => {
      const t = SpentOutputSchema.parse({
        mode: 0,
        value: 100,
        token_data: 0,
        script: 'aabb',
        decoded: { type: 'P2PKH', address: 'WT4n', timelock: null },
      });
      expect(t.mode).toBe(0);
      expect(t.value).toBe(100n);
    });

    it('accepts transparent with mode omitted (legacy wire format)', () => {
      const t = SpentOutputSchema.parse({
        value: 100,
        token_data: 0,
        script: 'aabb',
        decoded: { type: 'P2PKH', address: 'WT4n', timelock: null },
      });
      expect(t.mode).toBe(0);
      expect(t.value).toBe(100n);
    });

    it('accepts shielded with mode=1', () => {
      const s = SpentOutputSchema.parse({
        mode: 1,
        commitment: 'aa'.repeat(33),
        range_proof: 'bb'.repeat(64),
        script: 'cc'.repeat(20),
        ephemeral_pubkey: 'dd'.repeat(33),
        token_data: 1,
        decoded: { address: 'WT4n' },
      });
      expect(s.mode).toBe(1);
    });
  });

  describe('TxEventDataWithoutMetaSchema', () => {
    const baseVertex = {
      hash: 'f42fbcd1549389632236f85a80ad2dd8cac2f150501fb40b11210bad03718f79',
      timestamp: 1572653369,
      version: 1,
      weight: 18.664694903964126,
      nonce: 2,
      inputs: [],
      outputs: [
        {
          value: 1431,
          script: 'dqkU91U6sMdzgT3zxOtdIVGbqobP0FmIrA==',
          token_data: 0,
          decoded: {
            type: 'P2PKH',
            address: 'WT4n',
            timelock: null,
          },
        },
      ],
      parents: [
        '16ba3dbe424c443e571b00840ca54b9ff4cff467e10b6a15536e718e2008f952',
      ],
      tokens: [],
      token_name: null,
      token_symbol: null,
      signal_bits: 0,
    };

    it('accepts a vertex with shielded_outputs omitted and defaults to []', () => {
      const v = TxEventDataWithoutMetaSchema.parse(baseVertex);
      expect(v.shielded_outputs).toEqual([]);
    });

    it('accepts a vertex with a non-empty shielded_outputs array', () => {
      const v = TxEventDataWithoutMetaSchema.parse({
        ...baseVertex,
        shielded_outputs: [
          {
            mode: 1,
            commitment: 'aa'.repeat(33),
            range_proof: 'bb'.repeat(64),
            script: 'cc'.repeat(20),
            ephemeral_pubkey: 'dd'.repeat(33),
            token_data: 1,
            decoded: { address: 'WT4n' },
          },
          {
            mode: 2,
            commitment: 'aa'.repeat(33),
            range_proof: 'bb'.repeat(64),
            script: 'cc'.repeat(20),
            ephemeral_pubkey: 'dd'.repeat(33),
            asset_commitment: 'ee'.repeat(33),
            surjection_proof: 'ff'.repeat(64),
            decoded: { address: 'WT4n' },
          },
        ],
      });
      expect(v.shielded_outputs).toHaveLength(2);
      expect(v.shielded_outputs[0].mode).toBe(1);
      expect(v.shielded_outputs[1].mode).toBe(2);
    });
  });
});
