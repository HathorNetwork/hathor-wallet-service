/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import bs58check from 'bs58check';
import { Network, stopGLLBackgroundTask } from '@hathor/wallet-lib';
import { deriveShieldedAddress } from '@hathor/wallet-lib/lib/utils/shieldedAddress';
import {
  deriveScanChild,
  deriveSpendChild,
  encodeSpendAddress,
  encodeCtAddress,
  deriveCtAddress,
} from '@src/crypto/shieldedAddress';

const bip32 = BIP32Factory(ecc);

// Deterministic test keys at the CHANGE level (…'/0), matching wallet-lib's
// deriveShieldedAddress which derives just the index from these.
const SEED = Buffer.alloc(32, 7);
const root = bip32.fromSeed(SEED);
const scanChangeXpriv = root.derivePath("m/44'/280'/1'/0").toBase58();
const scanChangeXpub = root.derivePath("m/44'/280'/1'/0").neutered().toBase58();
const spendChangeXpriv = root.derivePath("m/44'/280'/2'/0").toBase58();
const spendChangeXpub = root.derivePath("m/44'/280'/2'/0").neutered().toBase58();

const network = new Network('mainnet');

afterAll(() => {
  // wallet-lib starts a background task on import; stop it so jest can exit clean.
  stopGLLBackgroundTask();
});

describe('shielded address derivation', () => {
  it('deriveScanChild returns a 32-byte privkey and its matching 33-byte compressed pubkey', () => {
    const { scanPrivkey, scanPubkey } = deriveScanChild(scanChangeXpriv, 0);
    expect(scanPrivkey).toHaveLength(32);
    expect(scanPubkey).toHaveLength(33);
    expect(Buffer.from(ecc.pointFromScalar(scanPrivkey, true) as Uint8Array)).toEqual(scanPubkey);
  });

  it('deriveScanChild derives distinct children per index', () => {
    const a = deriveScanChild(scanChangeXpriv, 0).scanPrivkey;
    const b = deriveScanChild(scanChangeXpriv, 1).scanPrivkey;
    expect(a.equals(b)).toBe(false);
  });

  it('deriveSpendChild (public derivation) matches private-side derivation at the same index', () => {
    const fromXpub = deriveSpendChild(spendChangeXpub, 3);
    const fromXpriv = deriveScanChild(spendChangeXpriv, 3).scanPubkey;
    expect(fromXpub).toEqual(fromXpriv);
  });

  it('deriveSpendChild derives a single level (index) from the change-level xpub', () => {
    const expected = bip32.fromBase58(spendChangeXpub).derive(7).publicKey;
    expect(deriveSpendChild(spendChangeXpub, 7)).toEqual(expected);
  });

  it('encodeSpendAddress produces a P2PKH address using the network p2pkh byte', () => {
    const pub = deriveSpendChild(spendChangeXpub, 0);
    const addr = encodeSpendAddress(pub, network);
    const decoded = Buffer.from(bs58check.decode(addr));
    expect(decoded[0]).toBe(network.getVersionBytes().p2pkh);
    expect(decoded.subarray(1)).toEqual(bitcoin.crypto.hash160(pub));
  });

  it('encodeCtAddress lays out shieldedByte || scanPub || spendPub with a valid double-sha256 checksum', () => {
    const scanPub = deriveScanChild(scanChangeXpriv, 0).scanPubkey;
    const spendPub = deriveSpendChild(spendChangeXpub, 0);
    const ct = encodeCtAddress(scanPub, spendPub, network);

    // bs58check.decode throws on a bad checksum, so a successful decode validates it.
    const payload = Buffer.from(bs58check.decode(ct));
    expect(payload).toHaveLength(1 + 33 + 33);
    expect(payload[0]).toBe(network.getVersionBytes().shielded);
    expect(payload.subarray(1, 34)).toEqual(scanPub);
    expect(payload.subarray(34, 67)).toEqual(spendPub);
  });

  it('deriveCtAddress composes scan privkey, spend address and ct address at an index', () => {
    const r = deriveCtAddress(scanChangeXpriv, spendChangeXpub, 5, network);
    const scanPub5 = deriveScanChild(scanChangeXpriv, 5).scanPubkey;
    const spendPub5 = deriveSpendChild(spendChangeXpub, 5);

    expect(r.scanPrivkey).toEqual(deriveScanChild(scanChangeXpriv, 5).scanPrivkey);
    expect(r.spendAddress).toBe(encodeSpendAddress(spendPub5, network));
    expect(r.ctAddress).toBe(encodeCtAddress(scanPub5, spendPub5, network));
  });

  it('matches wallet-lib deriveShieldedAddress exactly (parity — same addresses and keys)', () => {
    for (const index of [0, 1, 7, 42]) {
      const ours = deriveCtAddress(scanChangeXpriv, spendChangeXpub, index, network);
      const ref = deriveShieldedAddress(scanChangeXpub, spendChangeXpub, index, network.name);

      expect(ours.ctAddress).toBe(ref.base58);
      expect(ours.spendAddress).toBe(ref.spendAddress);
      // Our scan pubkey (recovered from the privkey we derived) must equal
      // wallet-lib's derived scan pubkey — this validates the scan-privkey path.
      expect(deriveScanChild(scanChangeXpriv, index).scanPubkey.toString('hex')).toBe(ref.scanPubkey);
      expect(deriveSpendChild(spendChangeXpub, index).toString('hex')).toBe(ref.spendPubkey);
    }
  });
});
