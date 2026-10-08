/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * End-to-end parity between a client and this service, with the real crypto
 * provider: a wallet's keys come from a seed the way wallet-lib derives them,
 * an output is built the way a sender's wallet-lib builds it, and this
 * service's own derivation and rewind must open it.
 *
 * The mocks in the other suites never read the scan key, so a scan key here
 * that differs from the client's would pass all of them, and then make every
 * real output a scan miss.
 */

import {
  Address,
  Network,
  walletUtils,
  cryptoUtils,
  constants,
  stopGLLBackgroundTask,
} from '@hathor/wallet-lib';
import { createShieldedOutputs } from '@hathor/wallet-lib/lib/shielded/creation';
import { ShieldedOutputMode as ClientShieldedOutputMode } from '@hathor/wallet-lib/lib/shielded/types';
import { deriveShieldedAddress } from '@hathor/wallet-lib/lib/utils/shieldedAddress';
import {
  IShieldedCryptoProvider,
  ShieldedScanMissError,
  clearShieldedCryptoProvider,
  rewindAmount,
  rewindFully,
  setShieldedCryptoProvider,
} from '@wallet-service/common';
import { deriveCtAddress } from '@wallet-service/common/src/crypto/shieldedAddress';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const binding: typeof import('@hathor/ct-crypto-node/provider') = require('@hathor/ct-crypto-node/provider');

const network = new Network('testnet');
const PIN = '123456';
const CUSTOM_TOKEN = 'ab'.repeat(32);

/** The keys a wallet registers with this service, as wallet-lib derives them from a seed. */
const walletFromSeed = (words: string) => {
  const accessData = walletUtils.generateAccessDataFromSeed(words, {
    pin: PIN, password: 'password', networkName: network.name,
  });
  return {
    scanXpriv: cryptoUtils.decryptData(accessData.scanMainKey!, PIN),
    scanXpub: accessData.scanXpubkey!,
    spendXpub: accessData.spendXpubkey!,
  };
};

// Two unrelated wallets: 24-word BIP39 test vectors.
const ALICE = walletFromSeed(`${'abandon '.repeat(23)}art`);
const BOB = walletFromSeed(`${'zoo '.repeat(23)}vote`);

/** What a sender's wallet-lib puts in a proposal for a recipient's ct address. */
const proposalTo = (ctAddress: string, value: bigint, token: string, mode: ClientShieldedOutputMode) => {
  const recipient = new Address(ctAddress, { network });
  return {
    address: recipient.getSpendAddress().base58,
    scanPubkey: recipient.getScanPubkey().toString('hex'),
    value,
    token,
    shieldedMode: mode,
  };
};

let provider: IShieldedCryptoProvider;

beforeAll(() => {
  provider = binding.createDefaultShieldedCryptoProvider();
  setShieldedCryptoProvider(provider);
});

afterAll(() => {
  clearShieldedCryptoProvider();
  stopGLLBackgroundTask();
});

describe('shielded derivation parity with wallet-lib', () => {
  it.each([0, 1, 20])('derives the same ct address and spend address at index %i', (index) => {
    const ours = deriveCtAddress(ALICE.scanXpriv, ALICE.spendXpub, index, network);
    const client = deriveShieldedAddress(ALICE.scanXpub, ALICE.spendXpub, index, network.name);

    expect(ours.ctAddress).toBe(client.base58);
    expect(ours.spendAddress).toBe(client.spendAddress);
  });
});

describe('outputs built by wallet-lib open with the scan key this service derives', () => {
  const index = 3;
  const alice = deriveCtAddress(ALICE.scanXpriv, ALICE.spendXpub, index, network);
  // Senders pay the address the wallet's own client derives and hands out, so
  // these outputs are encrypted to the client's scan pubkey; opening them with
  // the key this service derived is what checks the two agree.
  const aliceAddress = deriveShieldedAddress(ALICE.scanXpub, ALICE.spendXpub, index, network.name).base58;

  it('opens AmountShielded outputs of the native token and a custom token', async () => {
    // hathor-core needs at least two shielded outputs, so wallet-lib does too.
    const outputs = await createShieldedOutputs([
      proposalTo(aliceAddress, 150n, constants.NATIVE_TOKEN_UID, ClientShieldedOutputMode.AMOUNT_SHIELDED),
      proposalTo(aliceAddress, 42n, CUSTOM_TOKEN, ClientShieldedOutputMode.AMOUNT_SHIELDED),
    ], provider, network);

    // The token id as this service stores it: `'00'` for the native token.
    for (const [output, value, tokenId] of [[outputs[0], 150n, '00'], [outputs[1], 42n, CUSTOM_TOKEN]] as const) {
      // The on-chain address is the spend address this service claims for the wallet.
      expect(output.address).toBe(alice.spendAddress);
      const rewound = await rewindAmount({
        scanPrivkey: alice.scanPrivkey,
        ephemeralPubkey: output.ephemeralPubkey,
        commitment: output.commitment,
        rangeProof: output.rangeProof,
        tokenId,
      });
      expect(rewound.value).toBe(value);
    }
  });

  it('opens FullyShielded outputs and recovers their tokens in stored form', async () => {
    const outputs = await createShieldedOutputs(
      [
        proposalTo(aliceAddress, 7n, constants.NATIVE_TOKEN_UID, ClientShieldedOutputMode.FULLY_SHIELDED),
        proposalTo(aliceAddress, 9n, CUSTOM_TOKEN, ClientShieldedOutputMode.FULLY_SHIELDED),
      ],
      provider,
      network,
      [{ tokenUid: constants.NATIVE_TOKEN_UID }, { tokenUid: CUSTOM_TOKEN }],
    );

    const recovered = [];
    for (const output of outputs) {
      expect(output.address).toBe(alice.spendAddress);
      const rewound = await rewindFully({
        scanPrivkey: alice.scanPrivkey,
        ephemeralPubkey: output.ephemeralPubkey,
        commitment: output.commitment,
        rangeProof: output.rangeProof,
        assetCommitment: (output as { assetCommitment: Buffer }).assetCommitment,
      });
      recovered.push({ value: rewound.value, tokenUid: rewound.tokenUid });
    }
    expect(recovered).toStrictEqual([
      { value: 7n, tokenUid: '00' },
      { value: 9n, tokenUid: CUSTOM_TOKEN },
    ]);
  });

  it('does not open with another wallet\'s scan key', async () => {
    // Cross-wallet isolation: Bob's key, at the same index, must miss.
    const bob = deriveCtAddress(BOB.scanXpriv, BOB.spendXpub, index, network);
    const [output] = await createShieldedOutputs([
      proposalTo(aliceAddress, 150n, constants.NATIVE_TOKEN_UID, ClientShieldedOutputMode.AMOUNT_SHIELDED),
      proposalTo(aliceAddress, 1n, constants.NATIVE_TOKEN_UID, ClientShieldedOutputMode.AMOUNT_SHIELDED),
    ], provider, network);

    await expect(rewindAmount({
      scanPrivkey: bob.scanPrivkey,
      ephemeralPubkey: output.ephemeralPubkey,
      commitment: output.commitment,
      rangeProof: output.rangeProof,
      tokenId: '00',
    })).rejects.toBeInstanceOf(ShieldedScanMissError);
  });

  it('does not open with this wallet\'s scan key at another index', async () => {
    const otherIndex = deriveCtAddress(ALICE.scanXpriv, ALICE.spendXpub, index + 1, network);
    const [output] = await createShieldedOutputs([
      proposalTo(aliceAddress, 150n, constants.NATIVE_TOKEN_UID, ClientShieldedOutputMode.AMOUNT_SHIELDED),
      proposalTo(aliceAddress, 1n, constants.NATIVE_TOKEN_UID, ClientShieldedOutputMode.AMOUNT_SHIELDED),
    ], provider, network);

    await expect(rewindAmount({
      scanPrivkey: otherIndex.scanPrivkey,
      ephemeralPubkey: output.ephemeralPubkey,
      commitment: output.commitment,
      rangeProof: output.rangeProof,
      tokenId: '00',
    })).rejects.toBeInstanceOf(ShieldedScanMissError);
  });
});
