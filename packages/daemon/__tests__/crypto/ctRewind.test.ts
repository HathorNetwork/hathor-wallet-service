/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  rewindAmount,
  rewindFully,
  RewindError,
  AmountRewindArgs,
  FullyRewindArgs,
} from '../../src/crypto/ctRewind';

// The native @hathor/ct-crypto-node binding is introduced with the integration
// test suite. Until then the wrapper is a stub: both entry points throw
// RewindError so ingestion records a failed recovery, and tests that exercise
// the recovery path mock this module. This test pins the stub contract.
describe('ctRewind wrapper (stub)', () => {
  const amountArgs: AmountRewindArgs = {
    scanPrivkey: Buffer.alloc(32),
    ephemeralPubkey: Buffer.alloc(33),
    commitment: Buffer.alloc(33),
    rangeProof: Buffer.alloc(64),
    tokenUid: Buffer.alloc(32),
  };

  const fullyArgs: FullyRewindArgs = {
    scanPrivkey: Buffer.alloc(32),
    ephemeralPubkey: Buffer.alloc(33),
    commitment: Buffer.alloc(33),
    rangeProof: Buffer.alloc(64),
    assetCommitment: Buffer.alloc(33),
  };

  it('rewindAmount throws RewindError', () => {
    expect(() => rewindAmount(amountArgs)).toThrow(RewindError);
  });

  it('rewindFully throws RewindError', () => {
    expect(() => rewindFully(fullyArgs)).toThrow(RewindError);
  });
});
