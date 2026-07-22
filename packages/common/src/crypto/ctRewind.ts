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
 * or wasm `@hathor/ct-crypto-wasm` binding). Until a provider is registered the
 * two entry points reject with `RewindError`; ingestion treats that as a failed
 * recovery (the output lands in `recovery_state = 'recovery_failed'`). Tests
 * register a deterministic stub provider via `setShieldedCryptoProvider`.
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
  /** 32B token UID the output is denominated in (visible for AmountShielded). */
  tokenUid: Buffer;
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
  try {
    return await p.rewindAmountShieldedOutput(
      args.scanPrivkey,
      args.ephemeralPubkey,
      args.commitment,
      args.rangeProof,
      args.tokenUid,
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
