/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import z from 'zod';
import { bigIntUtils } from '@hathor/wallet-lib';

// Use type assertion to handle zod version compatibility
const bigIntSchema = bigIntUtils.bigIntCoercibleSchema as unknown as z.ZodType<bigint>;

export type WebSocketSendEvent =
  | {
    type: 'START_STREAM';
    window_size: number;
    last_ack_event_id?: number;
  }
  | {
    type: 'ACK';
    window_size: number;
    ack_event_id?: number;
  };

export enum FullNodeEventTypes {
  VERTEX_METADATA_CHANGED = 'VERTEX_METADATA_CHANGED',
  VERTEX_REMOVED = 'VERTEX_REMOVED',
  NEW_VERTEX_ACCEPTED = 'NEW_VERTEX_ACCEPTED',
  LOAD_STARTED = 'LOAD_STARTED',
  LOAD_FINISHED = 'LOAD_FINISHED',
  REORG_STARTED = 'REORG_STARTED',
  REORG_FINISHED = 'REORG_FINISHED',
  NC_EVENT = 'NC_EVENT',
  FULL_NODE_CRASHED = 'FULL_NODE_CRASHED',
}

/**
 * All events with transactions
 */
const StandardFullNodeEvents = z.union([
  z.literal('VERTEX_METADATA_CHANGED'),
  z.literal('NEW_VERTEX_ACCEPTED'),
]);

/**
 * Events without data
 */
const EmptyDataFullNodeEvents = z.union([
  z.literal('LOAD_STARTED'),
  z.literal('LOAD_FINISHED'),
  z.literal('REORG_FINISHED'),
  z.literal('FULL_NODE_CRASHED'),
]);

export const FullNodeEventBaseSchema = z.object({
  stream_id: z.string(),
  peer_id: z.string(),
  network: z.string(),
  type: z.string(),
  latest_event_id: z.number(),
});

export type FullNodeEventBase = z.infer<typeof FullNodeEventBaseSchema>;

export const EventTxOutputSchema = z.object({
  value: bigIntSchema,
  token_data: z.number(),
  script: z.string(),
  locked: z.boolean().optional(),
  decoded: z.union([
    z.object({
      type: z.string(),
      address: z.string(),
      timelock: z.number().nullable(),
    }).passthrough().nullable(),
    z.object({
      token_data: z.number().nullable(),
    }),
    z.object({}).strict(),
  ]),
});
export type EventTxOutput = z.infer<typeof EventTxOutputSchema>;

export const EventTxInputSchema = z.object({
  tx_id: z.string(),
  index: z.number(),
  spent_output: EventTxOutputSchema,
});
export type EventTxInput = z.infer<typeof EventTxInputSchema>;

export const EventTxNanoHeaderSchema = z.object({
  id: z.string(),
  nc_seqnum: z.number(),
  nc_id: z.string(),
  nc_method: z.string(),
  nc_address: z.string(),
});
export type EventTxNanoHeader = z.infer<typeof EventTxNanoHeaderSchema>;

export const TxEventDataWithoutMetaSchema = z.object({
  hash: z.string(),
  timestamp: z.number(),
  version: z.number(),
  weight: z.number(),
  nonce: bigIntSchema,
  inputs: EventTxInputSchema.array(),
  outputs: EventTxOutputSchema.array(),
  headers: EventTxNanoHeaderSchema.array().optional(),
  parents: z.string().array(),
  tokens: z.string().array(),
  token_name: z.string().nullable(),
  token_symbol: z.string().nullable(),
  signal_bits: z.number(),
});

export const TxEventDataSchema = TxEventDataWithoutMetaSchema.extend({
  metadata: z.object({
    hash: z.string(),
    voided_by: z.string().array(),
    first_block: z.string().nullable(),
    height: z.number(),
  }),
});

export const StandardFullNodeEventSchema = FullNodeEventBaseSchema.extend({
  event: z.object({
    id: z.number(),
    timestamp: z.number(),
    type: StandardFullNodeEvents,
    data: TxEventDataSchema,
  }),
});

export type StandardFullNodeEvent = z.infer<typeof StandardFullNodeEventSchema>;

export const ReorgFullNodeEventSchema = FullNodeEventBaseSchema.extend({
  event: z.object({
    id: z.number(),
    timestamp: z.number(),
    type: z.literal('REORG_STARTED'),
    data: z.object({
      reorg_size: z.number(),
      previous_best_block: z.string(),
      new_best_block: z.string(),
      common_block: z.string(),
    }),
    group_id: z.number(),
  }),
});
export type ReorgFullNodeEvent = z.infer<typeof ReorgFullNodeEventSchema>;

export const EmptyDataFullNodeEventSchema = FullNodeEventBaseSchema.extend({
  event: z.object({
    id: z.number(),
    timestamp: z.number(),
    type: EmptyDataFullNodeEvents,
    data: z.object({}).optional(),
  }),
});

export const TxDataWithoutMetaFullNodeEventSchema = FullNodeEventBaseSchema.extend({
  event: z.object({
    id: z.number(),
    timestamp: z.number(),
    type: z.literal('VERTEX_REMOVED'),
    data: TxEventDataWithoutMetaSchema,
  }),
});

export const NcEventSchema = FullNodeEventBaseSchema.extend({
  event: z.object({
    id: z.number(),
    timestamp: z.number(),
    type: z.literal('NC_EVENT'),
    data: z.object({
      vertex_id: z.string(),
      nc_id: z.string(),
      nc_execution: z.union([
        z.literal('pending'),
        z.literal('success'),
        z.literal('failure'),
        z.literal('skipped'),
      ]),
      first_block: z.string(),
      data_hex: z.string(),
    }),
    group_id: z.number().nullish(),
  }),
});
export type NcEvent = z.infer<typeof NcEventSchema>;

export const FullNodeEventSchema = z.union([
  TxDataWithoutMetaFullNodeEventSchema,
  StandardFullNodeEventSchema,
  ReorgFullNodeEventSchema,
  EmptyDataFullNodeEventSchema,
  NcEventSchema,
]);
export type FullNodeEvent = z.infer<typeof FullNodeEventSchema>;
