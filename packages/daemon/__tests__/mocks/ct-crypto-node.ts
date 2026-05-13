/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Deterministic mock for @hathor/ct-crypto-node used by integration tests.
 *
 * Calls to rewindAmountShieldedOutput / rewindFullShieldedOutput look up a
 * priming map keyed by (commitment, ephemeralPubkey). Tests prime the map
 * before exercising the daemon; unprimed calls throw.
 *
 * Tests that want this mock active should call:
 *   jest.mock('@hathor/ct-crypto-node', () => require('<path>/ct-crypto-node').mockCtCrypto);
 *
 * The mock is NOT installed globally (no moduleNameMapper) — unit tests like
 * ctRewind that need the real binding remain unaffected.
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

// The mock surface that stands in for @hathor/ct-crypto-node.
export const mockCtCrypto = {
  rewindAmountShieldedOutput(
    _scanPriv: Buffer,
    ephem: Buffer,
    commitment: Buffer,
    _rangeProof: Buffer,
    _tokenUid: Buffer,
  ) {
    const p = amountMap.get(key(commitment, ephem));
    if (!p) {
      throw new Error('mock: no AmountShielded priming for (commitment, ephemeralPubkey)');
    }
    return {
      value: p.value.toString(),
      blindingFactor: Buffer.alloc(32),
    };
  },

  rewindFullShieldedOutput(
    _scanPriv: Buffer,
    ephem: Buffer,
    commitment: Buffer,
    _rangeProof: Buffer,
    _assetCommitment: Buffer,
  ) {
    const p = fullyMap.get(key(commitment, ephem));
    if (!p) {
      throw new Error('mock: no FullyShielded priming for (commitment, ephemeralPubkey)');
    }
    return {
      value: p.value.toString(),
      blindingFactor: Buffer.alloc(32),
      tokenUid: p.tokenUid,
      assetBlindingFactor: Buffer.alloc(32),
    };
  },

  // Other symbols can be added as integration tests require them.
};
