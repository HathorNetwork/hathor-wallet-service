/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  rewindAmount,
  rewindFully,
  normalizeShieldedTokenId,
  RewindError,
  setShieldedCryptoProvider,
  clearShieldedCryptoProvider,
} from '@src/crypto/ctRewind';
import type { IShieldedCryptoProvider } from '@hathor/ct-crypto-provider';

const buf = (n: number, fill = 0): Buffer => Buffer.alloc(n, fill);

const amountArgs = () => ({
  scanPrivkey: buf(32, 1),
  ephemeralPubkey: buf(33, 2),
  commitment: buf(33, 3),
  rangeProof: buf(64, 4),
  tokenUid: buf(32, 0),
});

const fullyArgs = () => ({
  scanPrivkey: buf(32, 1),
  ephemeralPubkey: buf(33, 2),
  commitment: buf(33, 3),
  rangeProof: buf(64, 4),
  assetCommitment: buf(33, 5),
});

/** Minimal provider stub — only the two rewind methods the wrapper uses. */
const stubProvider = (
  overrides: Partial<IShieldedCryptoProvider>,
): IShieldedCryptoProvider => overrides as unknown as IShieldedCryptoProvider;

describe('ctRewind wrapper', () => {
  afterEach(() => clearShieldedCryptoProvider());

  it('rewindAmount rejects with RewindError when no provider is registered', async () => {
    await expect(rewindAmount(amountArgs())).rejects.toBeInstanceOf(RewindError);
  });

  it('rewindAmount delegates to the registered provider with positional args and returns its result', async () => {
    const result = { value: 1500n, blindingFactor: buf(32, 9) };
    const received: unknown[][] = [];
    setShieldedCryptoProvider(
      stubProvider({
        rewindAmountShieldedOutput: async (...a: unknown[]) => {
          received.push(a);
          return result;
        },
      }),
    );

    const args = amountArgs();
    await expect(rewindAmount(args)).resolves.toEqual(result);
    expect(received[0]).toEqual([
      args.scanPrivkey,
      args.ephemeralPubkey,
      args.commitment,
      args.rangeProof,
      args.tokenUid,
    ]);
  });

  it('rewindAmount wraps a provider failure in RewindError (preserving cause)', async () => {
    const cause = new Error('binding boom');
    setShieldedCryptoProvider(
      stubProvider({
        rewindAmountShieldedOutput: async () => {
          throw cause;
        },
      }),
    );

    await expect(rewindAmount(amountArgs())).rejects.toMatchObject({
      name: 'RewindError',
      cause,
    });
  });

  it('rewindFully rejects with RewindError when no provider is registered', async () => {
    await expect(rewindFully(fullyArgs())).rejects.toBeInstanceOf(RewindError);
  });

  it('rewindFully delegates and returns the provider result (custom token passes through)', async () => {
    const result = {
      value: 42n,
      blindingFactor: buf(32, 8),
      tokenUid: 'ab'.repeat(32), // custom token uid — already canonical
      assetBlindingFactor: buf(32, 7),
    };
    const received: unknown[][] = [];
    setShieldedCryptoProvider(
      stubProvider({
        rewindFullShieldedOutput: async (...a: unknown[]) => {
          received.push(a);
          return result;
        },
      }),
    );

    const args = fullyArgs();
    await expect(rewindFully(args)).resolves.toEqual(result);
    expect(received[0]).toEqual([
      args.scanPrivkey,
      args.ephemeralPubkey,
      args.commitment,
      args.rangeProof,
      args.assetCommitment,
    ]);
  });

  it('rewindFully canonicalizes the native token uid (all-zero -> "00")', async () => {
    setShieldedCryptoProvider(
      stubProvider({
        rewindFullShieldedOutput: async () => ({
          value: 42n,
          blindingFactor: buf(32, 8),
          tokenUid: '00'.repeat(32), // provider yields the raw on-chain native uid
          assetBlindingFactor: buf(32, 7),
        }),
      }),
    );

    const r = await rewindFully(fullyArgs());
    expect(r.tokenUid).toBe('00'); // folded to the canonical NATIVE_TOKEN_UID
    expect(r.value).toBe(42n);
  });
});

describe('normalizeShieldedTokenId', () => {
  it('folds the all-zero native uid to the canonical NATIVE_TOKEN_UID', () => {
    expect(normalizeShieldedTokenId('00'.repeat(32))).toBe('00');
  });

  it('leaves a custom token uid unchanged', () => {
    expect(normalizeShieldedTokenId('ab'.repeat(32))).toBe('ab'.repeat(32));
  });
});
