/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Confidential-transaction rewind wrapper.
 *
 * This module owns the typed surface the daemon uses to recover the cleartext
 * {value, token, blinding factors} of a shielded output from a scan key. The
 * actual recovery is performed by the native `@hathor/ct-crypto-node` binding,
 * which is introduced together with the integration test suite. Until then the
 * two entry points are stubs that throw `RewindError`; ingestion treats a throw
 * as a failed recovery (the output lands in `recovery_state = 'recovery_failed'`),
 * and unit/integration tests mock this wrapper to supply deterministic results.
 */

/**
 * Single error type surfaced by this wrapper. Callers can `catch (e) { if (e
 * instanceof RewindError) ... }` instead of trying to recognise the various
 * native errors thrown by the (future) NAPI binding.
 *
 * The original error (if any) is preserved in `cause` for logging / debugging —
 * do not pattern-match on it in production code paths.
 */
export class RewindError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RewindError';
  }
}

export interface AmountRewindArgs {
  /** 32B recipient scan private key. */
  scanPrivkey: Buffer;
  /** 33B compressed ephemeral pubkey from the output. */
  ephemeralPubkey: Buffer;
  /** 33B Pedersen value commitment from the output. */
  commitment: Buffer;
  /** Bulletproof range proof bytes from the output. */
  rangeProof: Buffer;
  /** 32B token UID the caller is testing the output against (0x00..00 for HTR). */
  tokenUid: Buffer;
}

export interface AmountRewindResult {
  /** Recovered amount in the token's smallest unit. */
  value: bigint;
  /** 32B value blinding factor. The daemon does NOT persist this. */
  blindingFactor: Buffer;
}

export interface FullyRewindArgs {
  scanPrivkey: Buffer;
  ephemeralPubkey: Buffer;
  commitment: Buffer;
  rangeProof: Buffer;
  /** 33B asset commitment from a "both-blindings" shielded output. */
  assetCommitment: Buffer;
}

export interface FullyRewindResult {
  value: bigint;
  blindingFactor: Buffer;
  /** 32B token UID recovered from the rangeproof message field. */
  tokenUid: Buffer;
  /** 32B asset blinding factor. */
  assetBlindingFactor: Buffer;
}

const NOT_INTEGRATED = 'ct-crypto-node rewind binding not yet integrated';

/**
 * Try to recover {value, blindingFactor} from a shielded output, assuming the
 * caller already knows which token UID the output is denominated in (i.e. an
 * amount-only shielded output).
 *
 * Stub: always throws `RewindError` until the native binding is wired in.
 */
export function rewindAmount(_args: AmountRewindArgs): AmountRewindResult {
  throw new RewindError(NOT_INTEGRATED);
}

/**
 * Try to recover {value, tokenUid, blindingFactor, assetBlindingFactor} from a
 * shielded output that includes an asset commitment (both-blindings form).
 *
 * Stub: always throws `RewindError` until the native binding is wired in.
 */
export function rewindFully(_args: FullyRewindArgs): FullyRewindResult {
  throw new RewindError(NOT_INTEGRATED);
}
