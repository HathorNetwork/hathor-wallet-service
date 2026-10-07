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
  isShieldedCryptoProviderRegistered,
  denormalizeShieldedTokenId,
  ShieldedScanMissError,
  ShieldedAssetMismatchError,
  initShieldedCryptoProvider,
  describeErrorChain,
} from '@src/crypto/ctRewind';
import { ScanMissError } from '@hathor/ct-crypto-provider';
import type { IShieldedCryptoProvider } from '@hathor/ct-crypto-provider';

const buf = (n: number, fill = 0): Buffer => Buffer.alloc(n, fill);

const amountArgs = () => ({
  scanPrivkey: buf(32, 1),
  ephemeralPubkey: buf(33, 2),
  commitment: buf(33, 3),
  rangeProof: buf(64, 4),
  tokenId: '00', // canonical native token
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
      // The canonical id is expanded before it reaches the provider.
      Buffer.from(denormalizeShieldedTokenId(args.tokenId), 'hex'),
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

  describe('isShieldedCryptoProviderRegistered', () => {
    it('is false before a provider is registered', () => {
      clearShieldedCryptoProvider();

      expect(isShieldedCryptoProviderRegistered()).toBe(false);
    });

    it('is true once a provider is registered and false again after it is cleared', () => {
      setShieldedCryptoProvider(
        stubProvider({
          rewindAmountShieldedOutput: jest.fn(),
          rewindFullShieldedOutput: jest.fn(),
        }),
      );
      expect(isShieldedCryptoProviderRegistered()).toBe(true);

      clearShieldedCryptoProvider();
      expect(isShieldedCryptoProviderRegistered()).toBe(false);
    });
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

describe('denormalizeShieldedTokenId', () => {
  it('expands the canonical native uid to its 32-byte on-chain form', () => {
    expect(denormalizeShieldedTokenId('00')).toBe('00'.repeat(32));
  });

  it('leaves a custom token uid unchanged', () => {
    expect(denormalizeShieldedTokenId('ab'.repeat(32))).toBe('ab'.repeat(32));
  });

  it('round-trips with normalizeShieldedTokenId', () => {
    expect(normalizeShieldedTokenId(denormalizeShieldedTokenId('00'))).toBe('00');
    const custom = 'cd'.repeat(32);
    expect(normalizeShieldedTokenId(denormalizeShieldedTokenId(custom))).toBe(custom);
  });
});

describe('rewindAmount token uid expansion', () => {
  afterEach(() => clearShieldedCryptoProvider());

  const recordingProvider = (seen: Buffer[]) => stubProvider({
    rewindAmountShieldedOutput: async (
      _k: Buffer, _e: Buffer, _c: Buffer, _r: Buffer, tokenUid: Buffer,
    ) => {
      seen.push(tokenUid);
      return { value: 1n, blindingFactor: buf(32) };
    },
  });

  it('hands the provider 32 bytes for the canonical native token', async () => {
    const seen: Buffer[] = [];
    setShieldedCryptoProvider(recordingProvider(seen));

    await rewindAmount(amountArgs());

    expect(seen[0]).toHaveLength(32);
    expect(seen[0].equals(Buffer.alloc(32, 0))).toBe(true);
  });

  it('hands the provider a custom token uid unchanged', async () => {
    const custom = 'cd'.repeat(32);
    const seen: Buffer[] = [];
    setShieldedCryptoProvider(recordingProvider(seen));

    await rewindAmount({ ...amountArgs(), tokenId: custom });

    expect(seen[0].toString('hex')).toBe(custom);
  });

  it('rejects a token id that is not 32 bytes once expanded', async () => {
    setShieldedCryptoProvider(recordingProvider([]));

    await expect(rewindAmount({ ...amountArgs(), tokenId: 'abcd' }))
      .rejects.toBeInstanceOf(RewindError);
  });
});

describe('scan misses', () => {
  afterEach(() => clearShieldedCryptoProvider());

  // A copy of the provider package other than the one the provider uses would
  // fail an `instanceof` check, so the wrapper must recognise it by name.
  const foreignScanMiss = () => Object.assign(new Error('rewind failed'), { name: 'ScanMissError' });

  it.each([
    ['the provider package class', () => new ScanMissError()],
    ['another copy of that class', foreignScanMiss],
  ])('rewindAmount reports a scan miss thrown as %s as ShieldedScanMissError', async (_label, make) => {
    const thrown = make();
    setShieldedCryptoProvider(stubProvider({
      rewindAmountShieldedOutput: async () => { throw thrown; },
    }));

    const err = await rewindAmount(amountArgs()).catch((e) => e);

    expect(err).toBeInstanceOf(ShieldedScanMissError);
    expect(err).toBeInstanceOf(RewindError);
    expect(err.cause).toBe(thrown);
  });

  it('rewindFully reports a scan miss as ShieldedScanMissError', async () => {
    setShieldedCryptoProvider(stubProvider({
      rewindFullShieldedOutput: async () => { throw foreignScanMiss(); },
    }));

    await expect(rewindFully(fullyArgs())).rejects.toBeInstanceOf(ShieldedScanMissError);
  });

  it('keeps any other provider failure a plain RewindError', async () => {
    setShieldedCryptoProvider(stubProvider({
      rewindAmountShieldedOutput: async () => { throw new Error('range proof is malformed'); },
    }));

    const err = await rewindAmount(amountArgs()).catch((e) => e);

    expect(err).toBeInstanceOf(RewindError);
    expect(err).not.toBeInstanceOf(ShieldedScanMissError);
  });
});

describe('initShieldedCryptoProvider', () => {
  afterEach(() => clearShieldedCryptoProvider());

  const working = () => stubProvider({ generateRandomBlindingFactor: async () => buf(32, 7) });

  it('registers a provider that loads and runs', async () => {
    expect(await initShieldedCryptoProvider(working)).toStrictEqual({ ok: true });
    expect(isShieldedCryptoProviderRegistered()).toBe(true);
  });

  it('reports a binding that fails to load, without throwing', async () => {
    const result = await initShieldedCryptoProvider(() => {
      throw new Error('Cannot find module ct-crypto.linux-x64-musl.node');
    });

    expect(result).toStrictEqual({ ok: false, error: expect.stringContaining('Cannot find module') });
    expect(isShieldedCryptoProviderRegistered()).toBe(false);
  });

  it('reports a binding that loads but cannot run, and does not register it', async () => {
    const result = await initShieldedCryptoProvider(() => stubProvider({
      generateRandomBlindingFactor: async () => { throw new Error('illegal instruction'); },
    }));

    expect(result).toMatchObject({ ok: false });
    expect(isShieldedCryptoProviderRegistered()).toBe(false);
  });

  it('leaves an already registered provider in place when a new one fails', async () => {
    const existing = working();
    setShieldedCryptoProvider(existing);

    await initShieldedCryptoProvider(() => { throw new Error('no binary'); });

    expect(isShieldedCryptoProviderRegistered()).toBe(true);
  });
});

describe('classifying a rewind that does not open', () => {
  afterEach(() => clearShieldedCryptoProvider());

  const scanMiss = () => Object.assign(new Error('rewind failed'), { name: 'ScanMissError' });
  const missingProvider = (verifyRangeProof?: (...a: unknown[]) => Promise<boolean>) => stubProvider({
    rewindAmountShieldedOutput: async () => { throw scanMiss(); },
    rewindFullShieldedOutput: async () => { throw scanMiss(); },
    deriveAssetTag: async () => buf(33, 8),
    ...(verifyRangeProof ? { verifyRangeProof } : {}),
  });

  it('keeps a miss whose proof verifies a scan miss', async () => {
    setShieldedCryptoProvider(missingProvider(async () => true));

    await expect(rewindAmount(amountArgs())).rejects.toBeInstanceOf(ShieldedScanMissError);
    await expect(rewindFully(fullyArgs())).rejects.toBeInstanceOf(ShieldedScanMissError);
  });

  it('reports a miss whose proof does not verify as a failed recovery', async () => {
    setShieldedCryptoProvider(missingProvider(async () => false));

    const err = await rewindAmount(amountArgs()).catch((e) => e);

    expect(err).toBeInstanceOf(RewindError);
    expect(err).not.toBeInstanceOf(ShieldedScanMissError);
    expect(err.message).toContain('does not verify');
  });

  it('verifies against the derived generator for amount-shielded and the asset commitment for fully-shielded', async () => {
    const generators: Buffer[] = [];
    setShieldedCryptoProvider(missingProvider(async (_proof, _commitment, generator) => {
      generators.push(generator as Buffer);
      return true;
    }));

    await rewindAmount(amountArgs()).catch(() => {});
    await rewindFully(fullyArgs()).catch(() => {});

    expect(generators).toStrictEqual([buf(33, 8), fullyArgs().assetCommitment]);
  });

  it('reports a verifier that throws as a failed recovery', async () => {
    setShieldedCryptoProvider(missingProvider(async () => { throw new Error('malformed proof'); }));

    const err = await rewindAmount(amountArgs()).catch((e) => e);

    expect(err).toBeInstanceOf(RewindError);
    expect(err).not.toBeInstanceOf(ShieldedScanMissError);
  });

  it('reports a failed asset cross-check as ShieldedAssetMismatchError', async () => {
    setShieldedCryptoProvider(stubProvider({
      rewindFullShieldedOutput: async () => { throw new Error('asset commitment verification failed'); },
    }));

    await expect(rewindFully(fullyArgs())).rejects.toBeInstanceOf(ShieldedAssetMismatchError);
  });
});

describe('describeErrorChain', () => {
  it('lists the message of every cause, outermost first', () => {
    const inner = new Error('libc.musl-x86_64.so.1: cannot open shared object file');
    const outer = new Error('Cannot find native binding', { cause: inner });

    expect(describeErrorChain(outer))
      .toBe('Cannot find native binding <- libc.musl-x86_64.so.1: cannot open shared object file');
  });

  it('describes a non-error value', () => {
    expect(describeErrorChain('boom')).toBe('boom');
  });
});
