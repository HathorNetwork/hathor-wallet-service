/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Deterministic shielded-crypto provider for daemon tests.
 *
 * Implements the two rewind methods of `IShieldedCryptoProvider` against a
 * priming map keyed by (commitment, ephemeralPubkey). Tests prime the map, then
 * register this provider via `resetCtCryptoMock()` (which the common rewind
 * wrapper delegates to). Unprimed calls throw, so the daemon marks the output
 * `recovery_failed`.
 *
 * Usage in a test file:
 *   import { resetCtCryptoMock, primeAmountRewind } from '../mocks/ct-crypto-node';
 *   beforeEach(() => resetCtCryptoMock());   // clears priming + registers provider
 */

import {
  setShieldedCryptoProvider,
  IShieldedCryptoProvider,
} from '@wallet-service/common';

interface AmountPriming {
  commitment: Buffer;
  ephemeralPubkey: Buffer;
  value: bigint;
  tokenUid: Buffer;
}
interface FullyPriming extends AmountPriming {
  assetCommitment: Buffer;
}

const amountMap = new Map<string, AmountPriming>();
const fullyMap = new Map<string, FullyPriming>();

/**
 * Every rangeProof the rewinds received, in call order. Rewinds resolve from
 * (commitment, ephemeralPubkey) only, so tests read this to check the proof
 * bytes the daemon decoded from the wire.
 */
export const receivedRangeProofs: Buffer[] = [];

function key(commitment: Buffer, ephem: Buffer): string {
  return commitment.toString('hex') + ':' + ephem.toString('hex');
}

/** Arguments of the most recent `rewindAmountShieldedOutput` call. */
export interface RecordedAmountRewindArgs {
  privateKey: Buffer;
  ephemeralPubkey: Buffer;
  commitment: Buffer;
  rangeProof: Buffer;
  tokenUid: Buffer;
}

let lastAmountArgs: RecordedAmountRewindArgs | null = null;

/** The last amount-rewind call, or null if none since the mock was reset. */
export function lastAmountRewindArgs(): RecordedAmountRewindArgs | null {
  return lastAmountArgs;
}

export function primeAmountRewind(p: AmountPriming): void {
  amountMap.set(key(p.commitment, p.ephemeralPubkey), p);
}

export function primeFullyRewind(p: FullyPriming): void {
  fullyMap.set(key(p.commitment, p.ephemeralPubkey), p);
}

const scanMisses = new Set<string>();

/**
 * Make both rewinds of this output throw the provider's scan-miss error, as
 * the real provider does when the scan key does not open the output.
 */
export function primeScanMiss(p: { commitment: Buffer; ephemeralPubkey: Buffer }): void {
  scanMisses.add(key(p.commitment, p.ephemeralPubkey));
}

// Built by name, as the wrapper recognises it, so the mock does not depend on
// which copy of the provider package resolves here.
const scanMissError = () => Object.assign(new Error('rewind failed'), { name: 'ScanMissError' });

const assetMismatches = new Set<string>();

/**
 * Make the full rewind of this output fail the asset cross-check, as the real
 * provider does when a sender puts a false token in the output.
 */
export function primeAssetMismatch(p: { commitment: Buffer; ephemeralPubkey: Buffer }): void {
  assetMismatches.add(key(p.commitment, p.ephemeralPubkey));
}

/**
 * A provider that resolves rewinds from the priming maps. Only the two rewind
 * methods used by the wrapper are implemented; the rest of the interface is
 * unused by these tests.
 */
const mockProvider = {
  async rewindAmountShieldedOutput(
    privateKey: Buffer,
    ephemeralPubkey: Buffer,
    commitment: Buffer,
    rangeProof: Buffer,
    tokenUid: Buffer,
  ) {
    receivedRangeProofs.push(rangeProof);
    lastAmountArgs = { privateKey, ephemeralPubkey, commitment, rangeProof, tokenUid };
    if (scanMisses.has(key(commitment, ephemeralPubkey))) {
      throw scanMissError();
    }
    const p = amountMap.get(key(commitment, ephemeralPubkey));
    if (!p) {
      throw new Error('mock: no AmountShielded priming for (commitment, ephemeralPubkey)');
    }
    // The asset generator is derived from this uid, so a real provider fails
    // on a mismatch too.
    if (!tokenUid.equals(p.tokenUid)) {
      throw new Error('mock: AmountShielded tokenUid does not match the priming');
    }
    return { value: p.value, blindingFactor: Buffer.alloc(32) };
  },

  async rewindFullShieldedOutput(
    _privateKey: Buffer,
    ephemeralPubkey: Buffer,
    commitment: Buffer,
    rangeProof: Buffer,
  ) {
    receivedRangeProofs.push(rangeProof);
    if (scanMisses.has(key(commitment, ephemeralPubkey))) {
      throw scanMissError();
    }
    if (assetMismatches.has(key(commitment, ephemeralPubkey))) {
      throw new Error('range proof error: asset commitment verification failed');
    }
    const p = fullyMap.get(key(commitment, ephemeralPubkey));
    if (!p) {
      throw new Error('mock: no FullyShielded priming for (commitment, ephemeralPubkey)');
    }
    return {
      value: p.value,
      blindingFactor: Buffer.alloc(32),
      tokenUid: p.tokenUid.toString('hex'),
      assetBlindingFactor: Buffer.alloc(32),
    };
  },
} as unknown as IShieldedCryptoProvider;

/** Clear priming and register the mock provider as the active shielded crypto provider. */
export function resetCtCryptoMock(): void {
  amountMap.clear();
  fullyMap.clear();
  scanMisses.clear();
  assetMismatches.clear();
  receivedRangeProofs.length = 0;
  lastAmountArgs = null;
  setShieldedCryptoProvider(mockProvider);
}
