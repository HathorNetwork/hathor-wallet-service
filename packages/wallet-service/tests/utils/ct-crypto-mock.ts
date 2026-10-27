/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Deterministic shielded-crypto provider for wallet-service tests.
 *
 * Implements the two rewind methods of `IShieldedCryptoProvider` against a
 * priming map keyed by (commitment, ephemeralPubkey). Tests prime the map, then
 * register this provider via `resetCtCryptoMock()` (which the common rewind
 * wrapper delegates to). Unprimed calls throw, so recovery is marked failed.
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

const mockProvider = {
  async rewindAmountShieldedOutput(
    privateKey: Buffer,
    ephemeralPubkey: Buffer,
    commitment: Buffer,
    rangeProof: Buffer,
    tokenUid: Buffer,
  ) {
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
  ) {
    if (scanMisses.has(key(commitment, ephemeralPubkey))) {
      throw scanMissError();
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
  lastAmountArgs = null;
  setShieldedCryptoProvider(mockProvider);
}
