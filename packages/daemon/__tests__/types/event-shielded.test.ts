/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  FullNodeEventSchema,
  ShieldedOutputSchema,
  SpentOutputSchema,
  TxEventDataWithoutMetaSchema,
} from '../../src/types/event';
import alphaV4ShieldedVertexEvent from '../__fixtures__/alpha-v4-shielded-vertex-event';
import alphaV4FullyShieldedSpendEvent from '../__fixtures__/alpha-v4-fully-shielded-spend-event';

describe('shielded event schemas', () => {
  describe('ShieldedOutputSchema', () => {
    it('accepts a mode=1 AmountShielded entry with token_data', () => {
      const v = ShieldedOutputSchema.parse({
        mode: 1,
        commitment: 'aa'.repeat(33),
        range_proof: Buffer.alloc(64, 0xbb).toString('base64'),
        script: Buffer.alloc(20, 0xcc).toString('base64'),
        ephemeral_pubkey: 'dd'.repeat(33),
        token_data: 1,
        decoded: { address: 'WT4nABC' },
      });
      expect(v.mode).toBe(1);
      if (v.mode === 1) {
        expect(v.token_data).toBe(1);
      }
    });

    it('accepts a mode=2 FullyShielded entry with asset_commitment and surjection_proof', () => {
      const v = ShieldedOutputSchema.parse({
        mode: 2,
        commitment: 'aa'.repeat(33),
        range_proof: Buffer.alloc(64, 0xbb).toString('base64'),
        script: Buffer.alloc(20, 0xcc).toString('base64'),
        ephemeral_pubkey: 'dd'.repeat(33),
        asset_commitment: 'ee'.repeat(33),
        surjection_proof: Buffer.alloc(64, 0xff).toString('base64'),
        decoded: { address: 'WT4nXYZ' },
      });
      expect(v.mode).toBe(2);
      if (v.mode === 2) {
        expect(v.asset_commitment).toBe('ee'.repeat(33));
        expect(v.surjection_proof).toBe(Buffer.alloc(64, 0xff).toString('base64'));
      }
    });

    it('rejects an unknown mode (mode=9)', () => {
      expect(() =>
        ShieldedOutputSchema.parse({
          mode: 9,
          commitment: 'aa'.repeat(33),
          range_proof: Buffer.alloc(64, 0xbb).toString('base64'),
          script: Buffer.alloc(20, 0xcc).toString('base64'),
          ephemeral_pubkey: 'dd'.repeat(33),
          decoded: { address: 'WT4n' },
        })
      ).toThrow();
    });
  });

  describe('ShieldedOutputSchema blob encoding', () => {
    const valid = {
      amount: {
        mode: 1,
        commitment: 'aa'.repeat(33),
        range_proof: Buffer.alloc(64, 0xbb).toString('base64'),
        script: Buffer.alloc(25, 0xcc).toString('base64'),
        ephemeral_pubkey: 'dd'.repeat(33),
        token_data: 0,
        decoded: { address: 'WT4n' },
      },
      fully: {
        mode: 2,
        commitment: 'aa'.repeat(33),
        range_proof: Buffer.alloc(64, 0xbb).toString('base64'),
        script: Buffer.alloc(25, 0xcc).toString('base64'),
        ephemeral_pubkey: 'dd'.repeat(33),
        asset_commitment: 'ee'.repeat(33),
        surjection_proof: Buffer.alloc(64, 0xff).toString('base64'),
        decoded: { address: 'WT4n' },
      },
    };
    const fields = [
      ['range_proof', valid.amount],
      ['script', valid.amount],
      ['surjection_proof', valid.fully],
    ] as const;

    it.each(fields)('accepts a base64 %s', (_field, output) => {
      expect(ShieldedOutputSchema.safeParse(output).success).toBe(true);
    });

    // hathor-core sends standard, padded base64. Hex that happens to be valid
    // base64 (any length that is a multiple of 4) cannot be told apart by syntax.
    const badValues = [
      ['empty', ''],
      ['a character outside the alphabet', 'dqkU!'],
      ['bad padding', 'dqkU='],
      ['the base64url alphabet', 'ab-_'],
    ];
    // An empty script is valid (see 'accepts an empty script'); the proofs
    // never are.
    it.each(fields.flatMap(([field, output]) => badValues
      .filter(([label]) => !(field === 'script' && label === 'empty'))
      .map(([label, value]) => [field, label, output, value] as const)))('rejects a %s with %s', (field, _label, output, value) => {
      expect(ShieldedOutputSchema.safeParse({ ...output, [field]: value }).success).toBe(false);
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
      if (t.mode === 0) {
        expect(t.value).toBe(100n);
      }
    });

    it('accepts transparent with mode omitted (legacy wire format)', () => {
      const t = SpentOutputSchema.parse({
        value: 100,
        token_data: 0,
        script: 'aabb',
        decoded: { type: 'P2PKH', address: 'WT4n', timelock: null },
      });
      expect(t.mode).toBe(0);
      if (t.mode === 0) {
        expect(t.value).toBe(100n);
      }
    });

    it('accepts shielded with mode=1', () => {
      const s = SpentOutputSchema.parse({
        mode: 1,
        commitment: 'aa'.repeat(33),
        range_proof: Buffer.alloc(64, 0xbb).toString('base64'),
        script: Buffer.alloc(20, 0xcc).toString('base64'),
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
            range_proof: Buffer.alloc(64, 0xbb).toString('base64'),
            script: Buffer.alloc(20, 0xcc).toString('base64'),
            ephemeral_pubkey: 'dd'.repeat(33),
            token_data: 1,
            decoded: { address: 'WT4n' },
          },
          {
            mode: 2,
            commitment: 'aa'.repeat(33),
            range_proof: Buffer.alloc(64, 0xbb).toString('base64'),
            script: Buffer.alloc(20, 0xcc).toString('base64'),
            ephemeral_pubkey: 'dd'.repeat(33),
            asset_commitment: 'ee'.repeat(33),
            surjection_proof: Buffer.alloc(64, 0xff).toString('base64'),
            decoded: { address: 'WT4n' },
          },
        ],
      });
      expect(v.shielded_outputs).toHaveLength(2);
      expect(v.shielded_outputs[0].mode).toBe(1);
      expect(v.shielded_outputs[1].mode).toBe(2);
    });
  });

  describe('fields hathor-core treats as optional', () => {
    // A copy of the real event, so each case differs from what hathor-core
    // actually sends by exactly the field under test.
    const realEvent = () => JSON.parse(JSON.stringify(alphaV4ShieldedVertexEvent));

    it.each([
      ['null', null],
      ['absent', undefined],
    ])('accepts an ephemeral_pubkey that is %s', (_label, value) => {
      const event = realEvent();
      event.event.data.shielded_outputs[0].ephemeral_pubkey = value;

      const result = FullNodeEventSchema.safeParse(event);

      expect(result.success).toBe(true);
      const so = (result as any).data.event.data.shielded_outputs[0];
      expect(so.ephemeral_pubkey ?? null).toBeNull();
    });

    it.each([
      ['null', null],
      ['absent', undefined],
      ['an empty object', {}],
    ])('reads a decoded that is %s as no address', (_label, value) => {
      const event = realEvent();
      event.event.data.shielded_outputs[0].decoded = value;

      const result = FullNodeEventSchema.safeParse(event);

      expect(result.success).toBe(true);
      const so = (result as any).data.event.data.shielded_outputs[0];
      expect(so.decoded).toBeNull();
    });

    it('accepts an empty script, which has no address', () => {
      const event = realEvent();
      event.event.data.shielded_outputs[0].script = '';
      event.event.data.shielded_outputs[0].decoded = null;

      const result = FullNodeEventSchema.safeParse(event);

      expect(result.success).toBe(true);
      const so = (result as any).data.event.data.shielded_outputs[0];
      expect(so.script).toBe('');
    });
  });

  describe('a shielded payload that does not match the schema', () => {
    // hathor-core verifies every shielded field before it emits a vertex, so
    // a mismatch here means the schema drifted from core. The event fails, so
    // sync stops on it and replays it once the schema is fixed.
    const realEvent = () => JSON.parse(JSON.stringify(alphaV4ShieldedVertexEvent));
    const issuePaths = (result: any) => result.error.issues.map((i: any) => i.path.join('.'));

    it('fails the event on an invalid field', () => {
      const event = realEvent();
      event.event.data.shielded_outputs[0].commitment = 'not hex';

      const result = FullNodeEventSchema.safeParse(event);

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('event.data.shielded_outputs.0.commitment');
    });

    it('fails the event on an unknown mode', () => {
      const event = realEvent();
      event.event.data.shielded_outputs[0].mode = 3;

      expect(FullNodeEventSchema.safeParse(event).success).toBe(false);
    });

    // Only null, absent and `{}` mean "no address"; any other shape is drift.
    it.each([
      ['an array', []],
      ['an object without an address', { type: 'P2PKH' }],
    ])('fails the event on a decoded that is %s', (_label, decoded) => {
      const event = realEvent();
      event.event.data.shielded_outputs[0].decoded = decoded;

      expect(FullNodeEventSchema.safeParse(event).success).toBe(false);
    });

    it('fails a shielded spent output missing a field', () => {
      const result = SpentOutputSchema.safeParse({
        mode: 2,
        commitment: 'aa'.repeat(33),
        range_proof: Buffer.alloc(64, 0xbb).toString('base64'),
        script: Buffer.alloc(20, 0xcc).toString('base64'),
        ephemeral_pubkey: 'dd'.repeat(33),
        surjection_proof: Buffer.alloc(64, 0xff).toString('base64'),
        decoded: { address: 'WT4n' },
      });

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('asset_commitment');
    });

    it('fails a transparent spent output that does not validate, naming the field', () => {
      const result = SpentOutputSchema.safeParse({ mode: 0, value: 1, token_data: 'x', script: '' });

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('token_data');
    });
  });

  describe('headers', () => {
    const realEvent = () => JSON.parse(JSON.stringify(alphaV4ShieldedVertexEvent));
    const issuePaths = (result: any) => result.error.issues.map((i: any) => i.path.join('.'));
    const nanoHeader = {
      id: '10', nc_seqnum: 1, nc_id: 'aa', nc_method: 'initialize', nc_address: 'WT4n',
    };

    it.each(['11', '12', '13'])('accepts and keeps a header with id %s, which the daemon ignores', (id) => {
      const event = realEvent();
      event.event.data.headers = [nanoHeader, { id, entries: [] }];

      const result = FullNodeEventSchema.safeParse(event);

      expect(result.success).toBe(true);
      expect((result as any).data.event.data.headers).toHaveLength(2);
    });

    // Mint and melt change token supply; ignoring them would lose it silently.
    it.each(['14', '15', '99'])('fails the event on a header with id %s', (id) => {
      const event = realEvent();
      event.event.data.headers = [{ id }];

      const result = FullNodeEventSchema.safeParse(event);

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('event.data.headers.0.id');
    });

    it('still fails a nano header missing its fields', () => {
      const event = realEvent();
      event.event.data.headers = [{ id: '10', nc_seqnum: 1 }];

      const result = FullNodeEventSchema.safeParse(event);

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('event.data.headers.0.nc_id');
    });
  });

  describe('real fullnode event', () => {
    // Event 47541 of testnet-shielded-outputs, as an experimental-shielded-outputs-alpha-v4
    // fullnode sends it: the first vertex with shielded outputs on that chain. hathor-core
    // base64-encodes range_proof and script, and hex-encodes commitment and ephemeral_pubkey.
    // services_with_db.test.ts ingests it and checks the stored bytes.
    it('parses a vertex with shielded outputs', () => {
      const result = FullNodeEventSchema.safeParse(alphaV4ShieldedVertexEvent);
      expect(result.success).toBe(true);
    });

    // Event 70473: FullyShielded outputs, with base64 surjection proofs, and an
    // input that spends a shielded output.
    it('parses a vertex with FullyShielded outputs that spends a shielded output', () => {
      const result = FullNodeEventSchema.safeParse(alphaV4FullyShieldedSpendEvent);
      expect(result.success).toBe(true);
    });
  });
});
