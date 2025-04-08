/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { z } from 'zod';

export const Sha256HexSchema = z.string().regex(/^[a-fA-F0-9]{64}$/);

export const BigIntSchema = z
  .union([z.bigint(), z.number(), z.string().regex(/^\d+$/)])
  .pipe(z.coerce.bigint());

export const EventTxOutputSchema = z.object({
  value: BigIntSchema,
  token_data: z.number(),
  script: z.string(),
  locked: z.boolean().optional(),
  decoded: z.object({
    type: z.string(),
    address: z.string(),
    timelock: z.number().nullish(),
  }),
});

export const EventTxInputSchema = z.object({
  tx_id: Sha256HexSchema,
  index: z.number().positive(),
  spent_output: EventTxOutputSchema,
})

export const FullNodeEventSchema = z.object({
  id: z.number(),
  timestamp: z.number().positive(),
  type: z.enum([
    'VERTEX_METADATA_CHANGED',
    'VERTEX_REMOVED',
    'NEW_VERTEX_ACCEPTED',
    'LOAD_STARTED',
    'LOAD_FINISHED',
    'REORG_FINISHED',
    'REORG_STARTED',
  ]),
  data: z.object({
    hash: Sha256HexSchema,
    timestamp: z.number().positive(),
    version: z.number().positive(),
    weight: z.number(),
    nonce: z.number(),
    inputs: z.array(EventTxInputSchema),
    outputs: z.array(EventTxOutputSchema),
    parents: z.array(Sha256HexSchema).length(2),
    tokens: z.array(z.string()),
    token_name: z.string().nullish(),
    token_symbol: z.string().nullish(),
    signal_bits: z.number(),
    metadata: z.object({
      hash: Sha256HexSchema,
      voided_by: z.array(z.string()),
      first_block: z.string().nullish(),
      height: z.number(),
    }),
  })
});
