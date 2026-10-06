/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createECDH } from 'crypto';

const mockAddAlert = jest.fn();
jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: mockAddAlert,
}));

import {
  Severity,
  ShieldedScanMissError,
  clearShieldedCryptoProvider,
  isShieldedCryptoProviderRegistered,
  rewindAmount,
  rewindFully,
} from '@wallet-service/common';
import { loadNodeShieldedCryptoProvider, registerShieldedCryptoProvider } from '../src/shieldedCrypto';

/** A secp256k1 keypair: 32-byte private key, 33-byte compressed public key. */
const keypair = () => {
  const ecdh = createECDH('secp256k1');
  ecdh.generateKeys();
  return { priv: ecdh.getPrivateKey(), pub: Buffer.from(ecdh.getPublicKey('hex', 'compressed'), 'hex') };
};

const HTR_UID = Buffer.alloc(32);

beforeEach(() => {
  clearShieldedCryptoProvider();
  mockAddAlert.mockClear();
});

afterAll(() => clearShieldedCryptoProvider());

describe('registerShieldedCryptoProvider', () => {
  it('registers the native provider on this platform', async () => {
    expect(await registerShieldedCryptoProvider()).toBe(true);
    expect(isShieldedCryptoProviderRegistered()).toBe(true);
    expect(mockAddAlert).not.toHaveBeenCalled();
  });

  it('alerts and carries on when the binding cannot load', async () => {
    const result = await registerShieldedCryptoProvider(() => {
      throw new Error('Cannot find module ./ct-crypto.linux-x64-musl.node');
    });

    expect(result).toBe(false);
    expect(isShieldedCryptoProviderRegistered()).toBe(false);
    expect(mockAddAlert).toHaveBeenCalledTimes(1);
    expect(mockAddAlert.mock.calls[0][0]).toBe('Shielded crypto provider failed to load');
    expect(mockAddAlert.mock.calls[0][2]).toBe(Severity.MAJOR);
    expect(mockAddAlert.mock.calls[0][3]).toMatchObject({
      error: expect.stringContaining('Cannot find module'),
    });
  });

  it('still returns when the alert itself fails', async () => {
    mockAddAlert.mockRejectedValueOnce(new Error('SQS is down'));

    await expect(registerShieldedCryptoProvider(() => { throw new Error('no binary'); }))
      .resolves.toBe(false);
  });
});

describe('the native provider behind the common rewind wrapper', () => {
  // Outputs are built with the real binding, so these check what the mocks
  // cannot: that the wrapper's arguments open a real output, and how a real
  // scan miss surfaces.
  beforeEach(async () => {
    await registerShieldedCryptoProvider();
  });

  const createHtrOutput = async (value: bigint, recipientPub: Buffer) => {
    const provider = loadNodeShieldedCryptoProvider();
    const blinding = await provider.generateRandomBlindingFactor();
    return provider.createAmountShieldedOutput(value, recipientPub, HTR_UID, blinding);
  };

  it('opens an HTR output sent to the scan key, from the canonical token id', async () => {
    const scan = keypair();
    const output = await createHtrOutput(1234n, scan.pub);

    const rewound = await rewindAmount({
      scanPrivkey: scan.priv,
      ephemeralPubkey: output.ephemeralPubkey,
      commitment: output.commitment,
      rangeProof: output.rangeProof,
      tokenId: '00',
    });

    expect(rewound.value).toBe(1234n);
  });

  it('opens a fully-shielded HTR output and reports its token canonically', async () => {
    const scan = keypair();
    const provider = loadNodeShieldedCryptoProvider();
    const output = await provider.createShieldedOutputWithBothBlindings(
      77n,
      scan.pub,
      HTR_UID,
      await provider.generateRandomBlindingFactor(),
      await provider.generateRandomBlindingFactor(),
    );

    const rewound = await rewindFully({
      scanPrivkey: scan.priv,
      ephemeralPubkey: output.ephemeralPubkey,
      commitment: output.commitment,
      rangeProof: output.rangeProof,
      assetCommitment: output.assetCommitment!,
    });

    expect(rewound.value).toBe(77n);
    expect(rewound.tokenUid).toBe('00');
  });

  it('reports an output sent to another key as a scan miss', async () => {
    const output = await createHtrOutput(1234n, keypair().pub);

    await expect(rewindAmount({
      scanPrivkey: keypair().priv,
      ephemeralPubkey: output.ephemeralPubkey,
      commitment: output.commitment,
      rangeProof: output.rangeProof,
      tokenId: '00',
    })).rejects.toBeInstanceOf(ShieldedScanMissError);
  });
});
