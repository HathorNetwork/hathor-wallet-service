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

export type MonitoringEvent =
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'EVENT_RECEIVED' }
  | { type: 'RECONNECTING' }
  | { type: 'PROCESSING_STARTED' }
  | { type: 'PROCESSING_COMPLETED' };

export enum EventTypes {
  WEBSOCKET_EVENT = 'WEBSOCKET_EVENT',
  FULLNODE_EVENT = 'FULLNODE_EVENT',
  WEBSOCKET_SEND_EVENT = 'WEBSOCKET_SEND_EVENT',
  HEALTHCHECK_EVENT = 'HEALTHCHECK_EVENT',
  MONITORING_EVENT = 'MONITORING_EVENT',
  MONITORING_IDLE_TIMEOUT = 'MONITORING_IDLE_TIMEOUT',
}

export enum FullNodeEventTypes {
  VERTEX_METADATA_CHANGED = 'VERTEX_METADATA_CHANGED',
  VERTEX_REMOVED = 'VERTEX_REMOVED',
  NEW_VERTEX_ACCEPTED = 'NEW_VERTEX_ACCEPTED',
  LOAD_STARTED = 'LOAD_STARTED',
  LOAD_FINISHED = 'LOAD_FINISHED',
  REORG_STARTED = 'REORG_STARTED',
  REORG_FINISHED = 'REORG_FINISHED',
  NC_EVENT = 'NC_EVENT',
  TOKEN_CREATED = 'TOKEN_CREATED',
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

export const FullNodeEventTypesSchema = z.nativeEnum(FullNodeEventTypes);

export type Event =
  | { type: EventTypes.WEBSOCKET_EVENT, event: WebSocketEvent }
  | { type: EventTypes.FULLNODE_EVENT, event: FullNodeEvent }
  | { type: EventTypes.WEBSOCKET_SEND_EVENT, event: WebSocketSendEvent }
  | { type: EventTypes.HEALTHCHECK_EVENT, event: HealthCheckEvent }
  | { type: EventTypes.MONITORING_EVENT, event: MonitoringEvent }
  | { type: EventTypes.MONITORING_IDLE_TIMEOUT };


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
    }).passthrough().nullable(),
    z.object({
      token_data: z.number().nullable(),
    }),
    z.object({}).strict(),
  ]),
});
export type EventTxOutput = z.infer<typeof EventTxOutputSchema>;

const HexStringSchema = z.string().regex(/^([0-9a-fA-F]{2})+$/);
// hathor-core's `_shielded_output_to_json` hex-encodes the fixed-size points
// (commitment, ephemeral_pubkey, asset_commitment) but base64-encodes the
// variable-size blobs (range_proof, script, surjection_proof), like the
// transparent `script`. `base64()` alone accepts an empty string.
const Base64StringSchema = z.string().min(1).base64();

const ShieldedDecodedSchema = z.object({
  address: z.string(),
  // unix seconds; absent ⇒ no timelock. Mirrors the transparent
  // `decoded.timelock` shape; the daemon derives `locked` locally from this
  // plus `vertex.heightlock` (shielded outputs don't carry an on-wire
  // `locked` flag).
  timelock: z.number().int().nullish(),
}).passthrough();

// hathor-core only writes `decoded` when the script is a recognised address
// script; otherwise it arrives as null, absent or `{}`. All three become null,
// so consumers have one "no address" case to handle.
const OptionalShieldedDecodedSchema = z.preprocess(
  (raw) => (
    raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0
      ? null
      : raw
  ),
  ShieldedDecodedSchema.nullish(),
);

// `.length(66)` pins commitment, ephemeral_pubkey and asset_commitment to 33
// bytes, the width of their VARBINARY(33) columns. checkShieldedOutputStorable
// relies on this and does not re-check them.
const BaseShieldedFieldsSchema = z.object({
  commitment: HexStringSchema.length(66),
  range_proof: Base64StringSchema,
  script: Base64StringSchema,
  // Optional in the protocol: hathor-core omits it (sends null) when the sender
  // supplied none, and such an output cannot be rewound.
  ephemeral_pubkey: HexStringSchema.length(66).nullish(),
  decoded: OptionalShieldedDecodedSchema,
});

export const AmountShieldedOutputSchema = BaseShieldedFieldsSchema.extend({
  mode: z.literal(1),
  token_data: z.number().int(),
});
export type AmountShieldedOutput = z.infer<typeof AmountShieldedOutputSchema>;

export const FullyShieldedOutputSchema = BaseShieldedFieldsSchema.extend({
  mode: z.literal(2),
  asset_commitment: HexStringSchema.length(66),
  surjection_proof: Base64StringSchema,
});
export type FullyShieldedOutput = z.infer<typeof FullyShieldedOutputSchema>;

export const ShieldedOutputSchema = z.discriminatedUnion('mode', [
  AmountShieldedOutputSchema,
  FullyShieldedOutputSchema,
]);
export type ShieldedOutput = z.infer<typeof ShieldedOutputSchema>;

/**
 * A shielded output of a known mode whose payload failed validation.
 *
 * Stands in for the output so its slot in the concatenated index space is
 * kept, while nothing from the payload is trusted: ingestion parks it and
 * alerts, and every other consumer skips it. A malformed payload is something
 * any sender can broadcast, so it must not stop sync — unlike an unknown mode,
 * which means the protocol moved on and still fails the whole event.
 */
export interface MalformedShieldedOutput {
  mode: ShieldedModeValue;
  malformed: true;
  reason: string;
}

type ShieldedModeValue = ShieldedOutput['mode'];

export type ShieldedOutputEntry = ShieldedOutput | MalformedShieldedOutput;

export const isMalformedShieldedOutput = (
  output: ShieldedOutputEntry | SpentOutput,
): output is MalformedShieldedOutput => (output as { malformed?: unknown }).malformed === true;

/** Longest `reason` kept on a malformed output; it ends up in logs and alerts. */
const MALFORMED_REASON_MAX_CHARS = 500;

const describeIssues = (error: z.ZodError): string => error.issues
  .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
  .join('; ')
  .slice(0, MALFORMED_REASON_MAX_CHARS);

const KnownShieldedModeSchema = z.object({
  mode: z.union([z.literal(1), z.literal(2)]),
}).passthrough();

/**
 * Parse a shielded output, or reduce it to a `MalformedShieldedOutput` when its
 * mode is known but the rest does not validate. Anything without a known mode
 * is left to the strict schema, which fails the event.
 */
const LenientShieldedOutputSchema = z.unknown().transform((raw, ctx): ShieldedOutputEntry => {
  const parsed = ShieldedOutputSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  const known = KnownShieldedModeSchema.safeParse(raw);
  if (!known.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue(issue);
    }
    return z.NEVER;
  }
  return { mode: known.data.mode, malformed: true, reason: describeIssues(parsed.error) };
});

const TransparentSpentOutputSchema = EventTxOutputSchema.extend({
  mode: z.literal(0),
});

export const SpentOutputSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('mode' in raw)) {
      return { ...raw, mode: 0 };
    }
    return raw;
  },
  z.union([
    // The output being spent was parked the same way when it was created, so
    // its spend has to parse leniently too or it would stop sync instead.
    // Tried first: the transparent `value` coercion throws, rather than
    // failing, on a value it cannot read, so it must not see shielded payloads.
    LenientShieldedOutputSchema,
    TransparentSpentOutputSchema,
  ]),
);
export type SpentOutput = z.infer<typeof SpentOutputSchema>;

export const EventTxInputSchema = z.object({
  tx_id: z.string(),
  index: z.number(),
  spent_output: SpentOutputSchema,
});
export type EventTxInput = z.infer<typeof EventTxInputSchema>;

const NANO_HEADER_ID = '10';

export const EventTxNanoHeaderSchema = z.object({
  id: z.string(),
  nc_seqnum: z.number(),
  nc_id: z.string(),
  nc_method: z.string(),
  nc_address: z.string(),
});
export type EventTxNanoHeader = z.infer<typeof EventTxNanoHeaderSchema>;

/**
 * Any header that is not a nano header. hathor-core emits only nano headers
 * today, but the protocol defines others; the daemon does not act on them, so
 * accepting them keeps a new header type from stopping sync. The id check
 * keeps a malformed nano header from slipping through as one of these.
 */
const EventTxOtherHeaderSchema = z.object({
  id: z.string().refine((id) => id !== NANO_HEADER_ID, 'a nano header must match the nano schema'),
}).passthrough();

export const EventTxHeaderSchema = z.union([EventTxNanoHeaderSchema, EventTxOtherHeaderSchema]);
export type EventTxHeader = z.infer<typeof EventTxHeaderSchema>;

export function isNanoHeader(header: EventTxHeader): header is EventTxNanoHeader {
  return header.id === NANO_HEADER_ID;
}

export const TxEventDataWithoutMetaSchema = z.object({
  hash: z.string(),
  timestamp: z.number(),
  version: z.number(),
  weight: z.number(),
  nonce: bigIntUtils.bigIntCoercibleSchema,
  inputs: EventTxInputSchema.array(),
  outputs: EventTxOutputSchema.array(),
  shielded_outputs: z.array(LenientShieldedOutputSchema).default([]),
  headers: EventTxHeaderSchema.array().optional(),
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
    /**
     * Nano contract execution state.
     *
     * This field indicates the execution status of nano contracts in this transaction:
     * - 'pending': Nano contract is waiting to be executed (before first_block)
     * - 'success': Nano contract executed successfully
     * - 'failure': Nano contract execution failed
     * - 'skipped': Nano contract execution was skipped
     * - null/undefined: Not a nano contract transaction, or execution state not available
     *
     * Important: This field is INDEPENDENT of transaction voiding (voided_by):
     * - A voided transaction might still have nc_execution = 'success'
     * - A non-voided transaction might have nc_execution = 'failure'
     *
     * Token Creation Implications:
     * - Tokens created by nano syscalls are only valid when nc_execution = 'success'
     * - When nc_execution changes from 'success' to any other state (e.g., during reorg),
     *   any tokens created by that nano execution must be deleted
     * - This is separate from CREATE_TOKEN_TX tokens, which are deleted only on void
     *
     * See handleVertexAccepted in services/index.ts for the token deletion logic.
     */
    nc_execution: z.union([
      z.literal('pending'),
      z.literal('success'),
      z.literal('failure'),
      z.literal('skipped'),
    ]).nullable().optional(),
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

export const TokenCreatedEventSchema = FullNodeEventBaseSchema.extend({
  event: z.object({
    id: z.number(),
    timestamp: z.number(),
    type: z.literal('TOKEN_CREATED'),
    data: z.object({
      token_uid: z.string(),
      nc_exec_info: z.object({
        nc_tx: z.string(),
        nc_block: z.string(),
      }).nullable(),
      token_name: z.string(),
      token_symbol: z.string(),
      token_version: z.number(),
      // Token amounts are BIGINT on the wire (up to 2^63-1). JSONBigInt parses
      // any value above Number.MAX_SAFE_INTEGER as a BigInt before Zod runs, so
      // a bare z.number() would reject large supplies and fail the whole event.
      // Match `value`/`nonce` and coerce so large amounts validate cleanly.
      initial_amount: bigIntUtils.bigIntCoercibleSchema.optional(),
    }),
    group_id: z.number().nullable(),
  }),
});
export type TokenCreatedEvent = z.infer<typeof TokenCreatedEventSchema>;

export const FullNodeEventSchema = z.union([
  TxDataWithoutMetaFullNodeEventSchema,
  StandardFullNodeEventSchema,
  ReorgFullNodeEventSchema,
  EmptyDataFullNodeEventSchema,
  NcEventSchema,
  TokenCreatedEventSchema,
]);
export type FullNodeEvent = z.infer<typeof FullNodeEventSchema>;

export interface LastSyncedEvent {
  id: number;
  last_event_id: number;
  updated_at: number;
}
