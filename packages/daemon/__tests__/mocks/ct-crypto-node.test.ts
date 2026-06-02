/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Replace the ctRewind wrapper with the deterministic mock for this test file.
jest.mock('../../src/crypto/ctRewind', () => require('./ct-crypto-node').mockCtCrypto);

import { resetCtCryptoMock, primeAmountRewind, primeFullyRewind } from './ct-crypto-node';
import { rewindAmount, rewindFully } from '../../src/crypto/ctRewind';

describe('ctRewind mock', () => {
  beforeEach(() => resetCtCryptoMock());

  it('primeAmountRewind makes rewindAmount return the primed value', () => {
    const commitment = Buffer.alloc(33, 0xaa);
    const ephem = Buffer.alloc(33, 0xbb);
    const tokenUid = Buffer.alloc(32, 0xcc);
    primeAmountRewind({ commitment, ephemeralPubkey: ephem, value: 1500n, tokenUid });

    const r = rewindAmount({
      scanPrivkey: Buffer.alloc(32),
      ephemeralPubkey: ephem,
      commitment,
      rangeProof: Buffer.alloc(64),
      tokenUid,
    });
    expect(r.value).toBe(1500n);
  });

  it('rewindAmount throws when no priming exists', () => {
    expect(() =>
      rewindAmount({
        scanPrivkey: Buffer.alloc(32),
        ephemeralPubkey: Buffer.alloc(33),
        commitment: Buffer.alloc(33),
        rangeProof: Buffer.alloc(64),
        tokenUid: Buffer.alloc(32),
      }),
    ).toThrow();
  });

  it('primeFullyRewind makes rewindFully return the primed value and token uid', () => {
    const commitment = Buffer.alloc(33, 0xdd);
    const ephem = Buffer.alloc(33, 0xee);
    const tokenUid = Buffer.from('aa'.repeat(32), 'hex');
    primeFullyRewind({
      commitment,
      ephemeralPubkey: ephem,
      value: 75n,
      tokenUid,
      assetCommitment: Buffer.alloc(33),
    });

    const r = rewindFully({
      scanPrivkey: Buffer.alloc(32),
      ephemeralPubkey: ephem,
      commitment,
      rangeProof: Buffer.alloc(64),
      assetCommitment: Buffer.alloc(33),
    });
    expect(r.value).toBe(75n);
    expect(r.tokenUid).toBe(tokenUid.toString('hex'));
  });
});
