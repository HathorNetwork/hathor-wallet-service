/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as cc from '@hathor/ct-crypto-node';

/**
 * Single error type surfaced by this wrapper. Callers can `catch (e) { if (e
 * instanceof RewindError) ... }` instead of trying to recognise the various
 * native errors thrown by the NAPI binding.
 *
 * The original native error (if any) is preserved in `cause` for logging /
 * debugging — do not pattern-match on it in production code paths.
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

/**
 * Try to recover {value, blindingFactor} from a shielded output, assuming the
 * caller already knows which token UID the output is denominated in (i.e. an
 * amount-only shielded output).
 *
 * Throws RewindError if the output does not belong to this scan key, the
 * input bytes are malformed, or the underlying binding throws for any other
 * reason.
 */
export function rewindAmount(args: AmountRewindArgs): AmountRewindResult {
  try {
    const r = cc.rewindAmountShieldedOutput(
      args.scanPrivkey,
      args.ephemeralPubkey,
      args.commitment,
      args.rangeProof,
      args.tokenUid,
    );
    return {
      value: BigInt(r.value),
      blindingFactor: Buffer.from(r.blindingFactor),
    };
  } catch (cause) {
    throw new RewindError('rewindAmountShieldedOutput failed', cause);
  }
}

/**
 * Try to recover {value, tokenUid, blindingFactor, assetBlindingFactor} from a
 * shielded output that includes an asset commitment (both-blindings form).
 *
 * Throws RewindError on any binding failure.
 *
 * NOTE: Independent asset-commitment verification (checking that the recovered
 * tokenUid + assetBlindingFactor reconstruct the on-chain asset_commitment) is
 * deferred. The current `@hathor/ct-crypto-node` binding exposes
 * `createAssetCommitment(tagBytes, rAsset)` — its first parameter is an asset
 * *tag*, not a tokenUid, so reconstructing the commitment requires an extra
 * `deriveAssetTag(tokenUid)` call and a mock surface for tests we don't yet
 * have. Until that helper lands we rely on the rewind itself to throw on a
 * mismatched scan key or corrupted payload.
 */
export function rewindFully(args: FullyRewindArgs): FullyRewindResult {
  try {
    const r = cc.rewindFullShieldedOutput(
      args.scanPrivkey,
      args.ephemeralPubkey,
      args.commitment,
      args.rangeProof,
      args.assetCommitment,
    );
    return {
      value: BigInt(r.value),
      blindingFactor: Buffer.from(r.blindingFactor),
      tokenUid: Buffer.from(r.tokenUid),
      assetBlindingFactor: Buffer.from(r.assetBlindingFactor),
    };
  } catch (cause) {
    throw new RewindError('rewindFullShieldedOutput failed', cause);
  }
}
