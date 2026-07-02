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

function key(commitment: Buffer, ephem: Buffer): string {
  return commitment.toString('hex') + ':' + ephem.toString('hex');
}

export function primeAmountRewind(p: AmountPriming): void {
  amountMap.set(key(p.commitment, p.ephemeralPubkey), p);
}

export function primeFullyRewind(p: FullyPriming): void {
  fullyMap.set(key(p.commitment, p.ephemeralPubkey), p);
}

/**
 * A provider that resolves rewinds from the priming maps. Only the two rewind
 * methods used by the wrapper are implemented; the rest of the interface is
 * unused by these tests.
 */
const mockProvider = {
  async rewindAmountShieldedOutput(
    _privateKey: Buffer,
    ephemeralPubkey: Buffer,
    commitment: Buffer,
  ) {
    const p = amountMap.get(key(commitment, ephemeralPubkey));
    if (!p) {
      throw new Error('mock: no AmountShielded priming for (commitment, ephemeralPubkey)');
    }
    return { value: p.value, blindingFactor: Buffer.alloc(32) };
  },

  async rewindFullShieldedOutput(
    _privateKey: Buffer,
    ephemeralPubkey: Buffer,
    commitment: Buffer,
  ) {
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
  setShieldedCryptoProvider(mockProvider);
}
