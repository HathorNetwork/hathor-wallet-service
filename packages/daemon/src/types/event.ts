/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import z from 'zod';
import { bigIntUtils } from '@hathor/wallet-lib';

export type WebSocketEvent =
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' };

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

export type HealthCheckEvent =
  | { type: 'START' }
  | { type: 'STOP' };

export enum EventTypes {
  WEBSOCKET_EVENT = 'WEBSOCKET_EVENT',
  FULLNODE_EVENT = 'FULLNODE_EVENT',
  METADATA_DECIDED = 'METADATA_DECIDED',
  WEBSOCKET_SEND_EVENT = 'WEBSOCKET_SEND_EVENT',
  HEALTHCHECK_EVENT = 'HEALTHCHECK_EVENT',
}

export enum FullNodeEventTypes {
  VERTEX_METADATA_CHANGED = 'VERTEX_METADATA_CHANGED',
  VERTEX_REMOVED = 'VERTEX_REMOVED',
  NEW_VERTEX_ACCEPTED = 'NEW_VERTEX_ACCEPTED',
  LOAD_STARTED = 'LOAD_STARTED',
  LOAD_FINISHED = 'LOAD_FINISHED',
  REORG_STARTED = 'REORG_STARTED',
  REORG_FINISHED= 'REORG_FINISHED',
  NC_EVENT= 'NC_EVENT',
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
]);

export const FullNodeEventTypesSchema = z.nativeEnum(FullNodeEventTypes);

export type MetadataDecidedEvent = {
  type: 'TX_VOIDED' | 'TX_UNVOIDED' | 'TX_NEW' | 'TX_FIRST_BLOCK' | 'IGNORE';
  originalEvent: FullNodeEvent;
}

export type Event =
  | { type: EventTypes.WEBSOCKET_EVENT, event: WebSocketEvent }
  | { type: EventTypes.FULLNODE_EVENT, event: FullNodeEvent }
  | { type: EventTypes.METADATA_DECIDED, event: MetadataDecidedEvent }
  | { type: EventTypes.WEBSOCKET_SEND_EVENT, event: WebSocketSendEvent }
  | { type: EventTypes.HEALTHCHECK_EVENT, event: HealthCheckEvent};


export interface VertexRemovedEventData {
  vertex_id: string;
}

export const FullNodeEventBaseSchema = z.object({
  stream_id: z.string(),
  peer_id: z.string(),
  network: z.string(),
  type: z.string(),
  latest_event_id: z.number(),
});

export type FullNodeEventBase = z.infer<typeof FullNodeEventBaseSchema>;

export const EventTxOutputSchema = z.object({
  value: bigIntUtils.bigIntCoercibleSchema,
  token_data: z.number(),
  script: z.string(),
  locked: z.boolean().optional(),
  decoded: z.union([
    z.object({
      type: z.string(),
      address: z.string(),
      timelock: z.number().nullable(),
    }).nullable(),
    z.object({}).strict()
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

// EventTxHeaderSchema should be a union of all possible header schemas.
// But currently only the nano header exists.
export const EventTxHeaderSchema = EventTxNanoHeaderSchema;
export type EventTxHeader = z.infer<typeof EventTxHeaderSchema>;

export function isNanoHeader(header: EventTxHeader): header is EventTxNanoHeader {
  return header.id === '10';
}

export const TxEventDataWithoutMetaSchema = z.object({
  hash: z.string(),
  timestamp: z.number(),
  version: z.number(),
  weight: z.number(),
  nonce: z.number(),
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

export interface LastSyncedEvent {
  id: number;
  last_event_id: number;
  updated_at: number;
}
