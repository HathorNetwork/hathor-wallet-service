/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { constants } from '@hathor/wallet-lib';
import {
  ADDRESS_COLUMN_MAX_CHARS,
  ShieldedOutputMode,
  TxInput,
  TxOutputWithIndex,
  isAuthority,
  isDecodedValid,
} from '@wallet-service/common';
import { DbTxOutput, EventTxHeader, isNanoHeader } from '../types';
import logger from '../logger';

/**
 * The `token_id` under which FullyShielded involvement is recorded in the
 * public address tables. Not hex, so it can never be a token UID or `'00'`,
 * and never matches a `token` row. The explorer queries the same literal.
 */
export const FULLY_SHIELDED_TOKEN_ID = 'fully_shielded';

/**
 * A transaction output, or the output an input spends, reduced to the columns
 * that are public on chain. A shielded output's value, a FullyShielded
 * output's token and anything a rewind produced have no field here, so they
 * cannot reach the public tables.
 */
export type PublicIo =
  | {
    mode: typeof ShieldedOutputMode.Transparent;
    address: string;
    tokenId: string;
    value: bigint;
    authorities: number;
  }
  | {
    mode: typeof ShieldedOutputMode.AmountShielded;
    address: string;
    /** From the output's `token_data`; null when it does not resolve. */
    tokenId: string | null;
  }
  | {
    mode: typeof ShieldedOutputMode.FullyShielded;
    address: string;
  };

/**
 * The stored row a shielded input spends, projected to its public columns.
 * `tokenId` is only read for AmountShielded rows, where it was set from
 * `token_data` when the output was stored and is never changed by a recovery.
 */
export type PublicSpentRow = Pick<DbTxOutput, 'txId' | 'index' | 'mode' | 'address' | 'tokenId'>;

/** One `public_address_tx_history` row of a vertex, without its tx id and timestamp. */
export interface PublicInvolvement {
  address: string;
  tokenId: string;
  /** Transparent delta: non-authority outputs minus non-authority inputs. */
  balance: bigint;
  /** At least one shielded output or input of this address and token. */
  hasShielded: boolean;
}

/**
 * The public involvement of one vertex: one entry per distinct
 * (address, token), derived from on-chain data only.
 *
 * - A transparent output or input counts under its token, adding or
 *   subtracting its value unless it is an authority.
 * - An AmountShielded output or input counts under its token with no balance.
 *   A token that cannot be determined is recorded under
 *   `FULLY_SHIELDED_TOKEN_ID` rather than guessed.
 * - A FullyShielded output or input counts under `FULLY_SHIELDED_TOKEN_ID`.
 * - A nano-contract caller with no other entry in this vertex gets an HTR
 *   entry with no balance, mirroring the empty HTR seed of the balance map,
 *   but decided from public entries only.
 *
 * An address wider than its column is dropped, as in `getInvolvedAddresses`.
 *
 * Ingest uses this through `getVertexPublicInvolvement`. Pass only the rows
 * that have a `tx_output` row: an output parked for storage, or an input
 * spending a missing row, contributes nothing.
 *
 * `db/scripts/backfill-public-address-tables.sql` applies the same rule in
 * SQL to stored rows; a change here must be made there too. The daemon's
 * tests run that script and compare its result with what ingest writes.
 */
export const getPublicInvolvement = (
  txId: string,
  outputs: PublicIo[],
  inputs: PublicIo[],
  ncAddresses: string[],
): PublicInvolvement[] => {
  const entries = new Map<string, PublicInvolvement>();
  const addresses = new Set<string>();

  const fits = (address: string): boolean => {
    if (address.length <= ADDRESS_COLUMN_MAX_CHARS) return true;
    logger.error('dropping an over-cap address from the public involvement', {
      txId,
      length: address.length,
      max: ADDRESS_COLUMN_MAX_CHARS,
    });
    return false;
  };

  const add = (address: string, tokenId: string, balance: bigint, hasShielded: boolean): void => {
    const key = `${address}:${tokenId}`;
    const entry = entries.get(key);
    if (entry) {
      entry.balance += balance;
      entry.hasShielded = entry.hasShielded || hasShielded;
    } else {
      entries.set(key, { address, tokenId, balance, hasShielded });
    }
    addresses.add(address);
  };

  const addIo = (io: PublicIo, sign: 1n | -1n, side: 'output' | 'input'): void => {
    if (!fits(io.address)) return;
    switch (io.mode) {
      case ShieldedOutputMode.Transparent:
        add(io.address, io.tokenId, io.authorities > 0 ? 0n : sign * io.value, false);
        return;
      case ShieldedOutputMode.AmountShielded:
        if (io.tokenId === null) {
          logger.warn('AmountShielded token is unknown; recording it as fully shielded', {
            txId, address: io.address, side,
          });
          add(io.address, FULLY_SHIELDED_TOKEN_ID, 0n, true);
          return;
        }
        add(io.address, io.tokenId, 0n, true);
        return;
      case ShieldedOutputMode.FullyShielded:
        add(io.address, FULLY_SHIELDED_TOKEN_ID, 0n, true);
        return;
      default: {
        const unknown: never = io;
        throw new Error(`Unknown output mode: ${JSON.stringify(unknown)}`);
      }
    }
  };

  for (const output of outputs) addIo(output, 1n, 'output');
  for (const input of inputs) addIo(input, -1n, 'input');

  for (const address of ncAddresses) {
    if (addresses.has(address) || !fits(address)) continue;
    add(address, constants.NATIVE_TOKEN_UID, 0n, false);
  }

  return [...entries.values()];
};

/** A stored shielded output, as `getVertexPublicInvolvement` takes it. */
export type StoredShieldedOutput = Exclude<PublicIo, { mode: typeof ShieldedOutputMode.Transparent }>;

/**
 * Project a stored spent row to the shape `getPublicInvolvement` takes, or
 * null for a transparent row (transparent inputs come from the wire).
 */
export const publicIoFromSpentRow = (row: PublicSpentRow): StoredShieldedOutput | null => {
  if (row.mode === ShieldedOutputMode.AmountShielded) {
    return { mode: ShieldedOutputMode.AmountShielded, address: row.address, tokenId: row.tokenId };
  }
  if (row.mode === ShieldedOutputMode.FullyShielded) {
    return { mode: ShieldedOutputMode.FullyShielded, address: row.address };
  }
  return null;
};

/**
 * The public involvement of a vertex being ingested.
 *
 * @param txOutputs - The transparent outputs, from `prepareOutputs`
 * @param txInputs - The transparent inputs, from `prepareInputs`
 * @param storedShieldedOutputs - The shielded outputs that got a `tx_output` row
 * @param spentShieldedRows - The rows spent by the shielded inputs left after
 *   `partitionShieldedInputs`, for the inputs whose row exists
 * @param headers - The vertex headers
 */
export const getVertexPublicInvolvement = (
  txId: string,
  txOutputs: TxOutputWithIndex[],
  txInputs: TxInput[],
  storedShieldedOutputs: StoredShieldedOutput[],
  spentShieldedRows: PublicSpentRow[],
  headers: EventTxHeader[],
): PublicInvolvement[] => {
  const outputs: PublicIo[] = [];
  for (const output of txOutputs) {
    // prepareOutputs only keeps outputs whose script decoded.
    if (!isDecodedValid(output.decoded, ['address'])) continue;
    const authority = isAuthority(output.token_data);
    outputs.push({
      mode: ShieldedOutputMode.Transparent,
      address: output.decoded.address,
      tokenId: output.token,
      value: authority ? 0n : BigInt(output.value),
      authorities: authority ? Number(output.value) : 0,
    });
  }
  outputs.push(...storedShieldedOutputs);

  const inputs: PublicIo[] = [];
  for (const input of txInputs) {
    if (!isDecodedValid(input.decoded, ['address'])) continue;
    const authority = isAuthority(input.token_data);
    inputs.push({
      mode: ShieldedOutputMode.Transparent,
      address: input.decoded.address,
      tokenId: input.token,
      value: authority ? 0n : BigInt(input.value),
      authorities: authority ? Number(input.value) : 0,
    });
  }
  for (const row of spentShieldedRows) {
    const io = publicIoFromSpentRow(row);
    if (io) inputs.push(io);
  }

  const ncAddresses = headers.filter(isNanoHeader).map((header) => header.nc_address);

  return getPublicInvolvement(txId, outputs, inputs, ncAddresses);
};
