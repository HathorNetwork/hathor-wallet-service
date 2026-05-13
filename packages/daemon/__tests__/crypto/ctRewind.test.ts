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
} from '../../src/crypto/ctRewind';

// Use the real binding for an integration-style sanity check on the wrapper.
// Crypto correctness is tested by @hathor/ct-crypto-node itself; this test
// only verifies the wrapper passes args through and shapes errors correctly.
describe('ctRewind wrapper', () => {
  it('throws RewindError on bad input shape', () => {
    const bogus: AmountRewindArgs = {
      scanPrivkey: Buffer.alloc(32),
      ephemeralPubkey: Buffer.alloc(33),
      commitment: Buffer.alloc(33),
      rangeProof: Buffer.alloc(64), // intentionally too small / invalid
      tokenUid: Buffer.alloc(32),
    };
    expect(() => rewindAmount(bogus)).toThrow(RewindError);
  });

  it('returns the recovered value on a valid input', () => {
    // Round-trip: build a valid AmountShielded output using the binding's own
    // creator, then rewind it. Self-consistent.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cc = require('@hathor/ct-crypto-node');

    // The recipient's "scan keypair" is just an EC keypair on secp256k1.
    // generateEphemeralKeypair gives us a valid pair we can re-use here.
    const recipient = cc.generateEphemeralKeypair();
    const tokenUid = Buffer.alloc(32, 0); // HTR (all-zero token UID)
    const valueBlindingFactor = cc.generateRandomBlindingFactor();

    const created = cc.createAmountShieldedOutput(
      1234n,
      recipient.publicKey,
      tokenUid,
      valueBlindingFactor,
    );

    const result = rewindAmount({
      scanPrivkey: recipient.privateKey,
      ephemeralPubkey: created.ephemeralPubkey,
      commitment: created.commitment,
      rangeProof: created.rangeProof,
      tokenUid,
    });

    expect(result.value).toBe(1234n);
    expect(Buffer.isBuffer(result.blindingFactor)).toBe(true);
    expect(result.blindingFactor.length).toBe(32);
  });

  it('rewindFully returns value, tokenUid and both blinding factors', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cc = require('@hathor/ct-crypto-node');

    const recipient = cc.generateEphemeralKeypair();
    const tokenUid = Buffer.alloc(32, 0); // HTR
    const valueBlindingFactor = cc.generateRandomBlindingFactor();
    const assetBlindingFactor = cc.generateRandomBlindingFactor();

    const created = cc.createShieldedOutputWithBothBlindings(
      5678n,
      recipient.publicKey,
      tokenUid,
      valueBlindingFactor,
      assetBlindingFactor,
    );

    const result = rewindFully({
      scanPrivkey: recipient.privateKey,
      ephemeralPubkey: created.ephemeralPubkey,
      commitment: created.commitment,
      rangeProof: created.rangeProof,
      assetCommitment: created.assetCommitment,
    });

    expect(result.value).toBe(5678n);
    expect(result.tokenUid.equals(tokenUid)).toBe(true);
    expect(result.blindingFactor.length).toBe(32);
    expect(result.assetBlindingFactor.length).toBe(32);
  });
});
