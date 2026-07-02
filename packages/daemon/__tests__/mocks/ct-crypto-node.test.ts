/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { resetCtCryptoMock, primeAmountRewind, primeFullyRewind } from './ct-crypto-node';
import { rewindAmount, rewindFully } from '@wallet-service/common';

describe('ctRewind mock', () => {
  beforeEach(() => resetCtCryptoMock());

  it('primeAmountRewind makes rewindAmount return the primed value', async () => {
    const commitment = Buffer.alloc(33, 0xaa);
    const ephem = Buffer.alloc(33, 0xbb);
    const tokenUid = Buffer.alloc(32, 0xcc);
    primeAmountRewind({ commitment, ephemeralPubkey: ephem, value: 1500n, tokenUid });

    const r = await rewindAmount({
      scanPrivkey: Buffer.alloc(32),
      ephemeralPubkey: ephem,
      commitment,
      rangeProof: Buffer.alloc(64),
      tokenUid,
    });
    expect(r.value).toBe(1500n);
  });

  it('rewindAmount rejects when no priming exists', async () => {
    await expect(
      rewindAmount({
        scanPrivkey: Buffer.alloc(32),
        ephemeralPubkey: Buffer.alloc(33),
        commitment: Buffer.alloc(33),
        rangeProof: Buffer.alloc(64),
        tokenUid: Buffer.alloc(32),
      }),
    ).rejects.toThrow();
  });

  it('primeFullyRewind makes rewindFully return the primed value and token uid', async () => {
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

    const r = await rewindFully({
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
