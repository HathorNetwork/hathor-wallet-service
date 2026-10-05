/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Confidential-transaction rewind wrapper.
 *
 * Owns the typed surface used to recover the cleartext {value, token, blinding
 * factors} of a shielded output from a scan key. The actual crypto is performed
 * by a registered `IShieldedCryptoProvider` (the NAPI `@hathor/ct-crypto-node`
 * or wasm `@hathor/ct-crypto-wasm` binding). With no provider registered the two
 * entry points reject with `RewindError`, so callers check
 * `isShieldedCryptoProviderRegistered()` first and skip the rewind entirely —
 * owned outputs stay in `recovery_state = 'unowned'`, which a later catch-up can
 * still promote. Tests register a deterministic stub provider via
 * `setShieldedCryptoProvider`.
 */

import hathorLib from '@hathor/wallet-lib';
import type {
  IShieldedCryptoProvider,
  IRewoundAmountShieldedOutput,
  IRewoundFullShieldedOutput,
} from '@hathor/ct-crypto-provider';

// Re-export the provider result/interface types so daemon and wallet-service
// consumers import them from one place instead of re-declaring them.
export type {
  IShieldedCryptoProvider,
  IRewoundAmountShieldedOutput,
  IRewoundFullShieldedOutput,
};

/**
 * Single error type surfaced by this wrapper. Callers can
 * `catch (e) { if (e instanceof RewindError) ... }` instead of recognising the
 * various native errors thrown by the underlying binding. The original error
 * (if any) is preserved in `cause` for logging — do not pattern-match on it in
 * production code paths.
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
  /**
   * Canonical token id as stored (`"00"` for the native token, else the 64-hex
   * on-chain uid). Expanded to the provider's 32-byte form internally — callers
   * pass what `tx_output.token_id` holds and never build the buffer themselves.
   */
  tokenId: string;
}

export interface FullyRewindArgs {
  scanPrivkey: Buffer;
  ephemeralPubkey: Buffer;
  commitment: Buffer;
  rangeProof: Buffer;
  /** 33B asset commitment from a fully-shielded output. */
  assetCommitment: Buffer;
}

const NO_PROVIDER = 'shielded crypto provider not registered';

let provider: IShieldedCryptoProvider | null = null;

/** Register the crypto provider that backs the rewind operations. */
export function setShieldedCryptoProvider(instance: IShieldedCryptoProvider): void {
  provider = instance;
}

/** Clear the registered provider — primarily for test isolation. */
export function clearShieldedCryptoProvider(): void {
  provider = null;
}

/**
 * Whether a provider is available for the rewind entry points.
 *
 * Callers use this to skip work that can only fail: with no provider, an
 * attempted rewind throws `RewindError` and the output would be recorded as
 * `recovery_failed` — a state the daemon's promote helper cannot leave — so
 * ingestion and catch-up both leave such outputs `unowned` instead.
 *
 * Read this per unit of work rather than caching it: a provider can be
 * registered at any point, and a cached `false` would suppress real failures
 * once one exists.
 */
export function isShieldedCryptoProviderRegistered(): boolean {
  return provider !== null;
}

function requireProvider(): IShieldedCryptoProvider {
  if (!provider) {
    throw new RewindError(NO_PROVIDER);
  }
  return provider;
}

/**
 * Recover {value, blindingFactor} from an amount-shielded output whose token UID
 * is already known from the visible `token_data` field.
 */
export async function rewindAmount(
  args: AmountRewindArgs,
): Promise<IRewoundAmountShieldedOutput> {
  const p = requireProvider();
  // Expanded here rather than at each call site: `tx_output.token_id` holds the
  // canonical form, and hex-decoding that directly yields one byte for the
  // native token where the asset generator needs 32.
  const tokenUid = Buffer.from(denormalizeShieldedTokenId(args.tokenId), 'hex');
  if (tokenUid.length !== 32) {
    throw new RewindError(`shielded token uid must be 32 bytes, got ${tokenUid.length}`);
  }
  try {
    return await p.rewindAmountShieldedOutput(
      args.scanPrivkey,
      args.ephemeralPubkey,
      args.commitment,
      args.rangeProof,
      tokenUid,
    );
  } catch (e) {
    if (e instanceof RewindError) throw e;
    throw new RewindError('shielded amount rewind failed', e);
  }
}

/**
 * Canonicalize a token uid recovered from a fully-shielded rewind.
 *
 * `rewindFully` returns the token uid in its raw 32-byte on-chain form; for the
 * native token (HTR) that is `NATIVE_TOKEN_UID_HEX` — 64 zero hex chars.
 * Everywhere else in the system HTR is the canonical `NATIVE_TOKEN_UID` ("00"),
 * so a fully-shielded HTR output must be normalized before it is stored, or its
 * balance lands under a separate token_id row that every balance query misses.
 * Custom tokens need no normalization: their on-chain uid is already canonical.
 */
export const normalizeShieldedTokenId = (tokenUidHex: string): string => (
  tokenUidHex === hathorLib.constants.NATIVE_TOKEN_UID_HEX
    ? hathorLib.constants.NATIVE_TOKEN_UID
    : tokenUidHex
);

/**
 * Inverse of `normalizeShieldedTokenId`: expand a stored token id to the
 * 32-byte on-chain form the crypto provider expects.
 *
 * The provider derives the asset generator from the raw uid, so the native
 * token must reach it as `NATIVE_TOKEN_UID_HEX` (32 zero bytes) rather than the
 * canonical `NATIVE_TOKEN_UID` (`"00"`) used throughout storage. A custom
 * token's id is already the on-chain form and is returned unchanged.
 */
export const denormalizeShieldedTokenId = (tokenIdHex: string): string => (
  tokenIdHex === hathorLib.constants.NATIVE_TOKEN_UID
    ? hathorLib.constants.NATIVE_TOKEN_UID_HEX
    : tokenIdHex
);

/**
 * Recover {value, tokenUid, blindingFactor, assetBlindingFactor} from a
 * fully-shielded output that hides both amount and token.
 *
 * The returned `tokenUid` is canonicalized: the provider yields the raw on-chain
 * uid, and for the native token (HTR) that is the all-zero `NATIVE_TOKEN_UID_HEX`
 * form; this folds it back to the system-wide `NATIVE_TOKEN_UID` so callers never
 * have to remember to normalize (custom tokens are already canonical, unchanged).
 */
export async function rewindFully(
  args: FullyRewindArgs,
): Promise<IRewoundFullShieldedOutput> {
  const p = requireProvider();
  try {
    const result = await p.rewindFullShieldedOutput(
      args.scanPrivkey,
      args.ephemeralPubkey,
      args.commitment,
      args.rangeProof,
      args.assetCommitment,
    );
    return { ...result, tokenUid: normalizeShieldedTokenId(result.tokenUid) };
  } catch (e) {
    if (e instanceof RewindError) throw e;
    throw new RewindError('shielded full rewind failed', e);
  }
}
