/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Tell Jest to use the mock module in place of the real binding for this test file.
jest.mock('@hathor/ct-crypto-node', () => require('./ct-crypto-node').mockCtCrypto);

import { resetCtCryptoMock, primeAmountRewind, primeFullyRewind } from './ct-crypto-node';
import * as cc from '@hathor/ct-crypto-node';

describe('@hathor/ct-crypto-node mock', () => {
  beforeEach(() => resetCtCryptoMock());

  it('primeAmountRewind makes rewindAmountShieldedOutput return the primed value', () => {
    const commitment = Buffer.alloc(33, 0xaa);
    const ephem = Buffer.alloc(33, 0xbb);
    const tokenUid = Buffer.alloc(32, 0xcc);
    primeAmountRewind({ commitment, ephemeralPubkey: ephem, value: 1500n, tokenUid });

    const r = (cc as any).rewindAmountShieldedOutput(
      Buffer.alloc(32), ephem, commitment, Buffer.alloc(64), tokenUid,
    );
    expect(BigInt(r.value)).toBe(1500n);
  });

  it('rewindAmountShieldedOutput throws when no priming exists', () => {
    expect(() => (cc as any).rewindAmountShieldedOutput(
      Buffer.alloc(32), Buffer.alloc(33), Buffer.alloc(33), Buffer.alloc(64), Buffer.alloc(32),
    )).toThrow();
  });

  it('primeFullyRewind returns the primed value and token uid', () => {
    const commitment = Buffer.alloc(33, 0xdd);
    const ephem = Buffer.alloc(33, 0xee);
    const tokenUid = Buffer.from('aa'.repeat(32), 'hex');
    primeFullyRewind({
      commitment, ephemeralPubkey: ephem, value: 75n, tokenUid,
      assetCommitment: Buffer.alloc(33),
    });

    const r = (cc as any).rewindFullShieldedOutput(
      Buffer.alloc(32), ephem, commitment, Buffer.alloc(64), Buffer.alloc(33),
    );
    expect(BigInt(r.value)).toBe(75n);
    expect(Buffer.from(r.tokenUid).toString('hex')).toBe(tokenUid.toString('hex'));
  });
});
