/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Shielded (confidential-transaction) address derivation.
 *
 * Mirrors wallet-lib's `deriveShieldedAddress` (kept byte-for-byte compatible by
 * a parity test) but uses bitcoinjs/bip32 rather than wallet-lib's bitcore path,
 * which is faster on the address-derivation hot path. Two BIP32 paths advance in
 * lockstep at the same index — a scan path (private, used to rewind received
 * outputs) and a spend path (public; the private half stays with the user's
 * wallet). The keys are supplied at the **change level** (`m/44'/280'/1'/0` scan,
 * `m/44'/280'/2'/0` spend), so deriving an index is a single BIP32 step. Key
 * derivation is network-agnostic (Hathor reuses Bitcoin's BIP32 version bytes);
 * only address *encoding* reads network bytes.
 *
 * Both encodings use base58check (a 4-byte double-sha256 checksum — Hathor's
 * address checksum). The spend address uses the transparent P2PKH byte
 * (`getVersionBytes().p2pkh`); the long-form `ct_address` uses the `shielded`
 * byte. Both come from the passed-in wallet-lib `Network`.
 */

import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import bs58check from 'bs58check';
import type { Network } from '@hathor/wallet-lib';

const bip32 = BIP32Factory(ecc);

export interface ScanChild {
  /** 32-byte per-index scan private key (persisted on the address row). */
  scanPrivkey: Buffer;
  /** 33-byte compressed scan public key (intermediate; recoverable from the privkey). */
  scanPubkey: Buffer;
}

/** Derive the scan child (private + public) at `index` from the change-level scan xpriv. */
export function deriveScanChild(scanXpriv: string, index: number): ScanChild {
  const node = bip32.fromBase58(scanXpriv).derive(index);
  if (!node.privateKey) {
    throw new Error('scan xpriv did not yield a private key');
  }
  return { scanPrivkey: node.privateKey, scanPubkey: node.publicKey };
}

/** Derive the spend child public key at `index` from the change-level spend xpub. */
export function deriveSpendChild(spendXpub: string, index: number): Buffer {
  return bip32.fromBase58(spendXpub).derive(index).publicKey;
}

/** Encode the on-chain P2PKH spend address (the ownership match key) from a spend pubkey. */
export function encodeSpendAddress(spendPubkey: Buffer, network: Network): string {
  const payload = Buffer.concat([
    Buffer.from([network.getVersionBytes().p2pkh]),
    bitcoin.crypto.hash160(spendPubkey),
  ]);
  return bs58check.encode(payload);
}

/**
 * Encode the long-form display `ct_address`:
 *   base58check( shieldedByte || scanPubkey(33) || spendPubkey(33) )
 */
export function encodeCtAddress(
  scanPubkey: Buffer,
  spendPubkey: Buffer,
  network: Network,
): string {
  const payload = Buffer.concat([
    Buffer.from([network.getVersionBytes().shielded]),
    scanPubkey,
    spendPubkey,
  ]);
  return bs58check.encode(payload);
}

export interface DerivedCtAddress {
  ctAddress: string;
  spendAddress: string;
  scanPrivkey: Buffer;
}

/**
 * Derive everything an ownership row needs at a shielded index: the long-form
 * `ct_address`, the on-chain `spend_address`, and the per-index `scan_privkey`.
 */
export function deriveCtAddress(
  scanXpriv: string,
  spendXpub: string,
  index: number,
  network: Network,
): DerivedCtAddress {
  const { scanPrivkey, scanPubkey } = deriveScanChild(scanXpriv, index);
  const spendPubkey = deriveSpendChild(spendXpub, index);
  return {
    ctAddress: encodeCtAddress(scanPubkey, spendPubkey, network),
    spendAddress: encodeSpendAddress(spendPubkey, network),
    scanPrivkey,
  };
}
