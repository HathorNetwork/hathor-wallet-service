/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Deterministic mock for the ctRewind wrapper used by integration tests.
 *
 * Calls to rewindAmount / rewindFully look up a priming map keyed by
 * (commitment, ephemeralPubkey). Tests prime the map before exercising the
 * daemon; unprimed calls throw.
 *
 * Tests that want this mock active should call:
 *   jest.mock('../../src/crypto/ctRewind', () => require('<path>/ct-crypto-node').mockCtCrypto);
 *
 * The mock is NOT installed globally (no moduleNameMapper) — unit tests that
 * need the real stub remain unaffected.
 */

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

export function resetCtCryptoMock(): void {
  amountMap.clear();
  fullyMap.clear();
}

export function primeAmountRewind(p: AmountPriming): void {
  amountMap.set(key(p.commitment, p.ephemeralPubkey), p);
}

export function primeFullyRewind(p: FullyPriming): void {
  fullyMap.set(key(p.commitment, p.ephemeralPubkey), p);
}

// The mock surface that stands in for ../../src/crypto/ctRewind.
export const mockCtCrypto = {
  rewindAmount(args: { ephemeralPubkey: Buffer; commitment: Buffer; [k: string]: unknown }) {
    const p = amountMap.get(key(args.commitment, args.ephemeralPubkey));
    if (!p) {
      throw new Error('mock: no AmountShielded priming for (commitment, ephemeralPubkey)');
    }
    return {
      value: p.value,
      blindingFactor: Buffer.alloc(32),
    };
  },

  rewindFully(args: { ephemeralPubkey: Buffer; commitment: Buffer; [k: string]: unknown }) {
    const p = fullyMap.get(key(args.commitment, args.ephemeralPubkey));
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
};
