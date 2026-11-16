import { arrayShuffle, sha256d, isTxVoided, buildAuthMessage, verifyMessageSignature } from '@src/utils';
import hathorLib, { walletUtils, network } from '@hathor/wallet-lib';
import bitcore from 'bitcore-lib';
import * as Fullnode from '@src/fullnode';
import { TEST_SEED, XPUBKEY, AUTH_XPUBKEY, ADDRESSES, getXPrivKeyFromSeed } from '@tests/utils';

// bitcore signs with Bitcoin's magic by default; the wallet-service verifies with
// the Hathor prefix, so tests must align bitcore's magic before signing.
bitcore.Message.MAGIC_BYTES = Buffer.from('Hathor Signed Message:\n');

test('sha256d', () => {
  expect.hasAssertions();
  // sha256d(my-test-data) -> 4f1ba9a4204e97a293b16ead6caced38f6d91d95618b96e261c6332ed24f7894
  // sha256d(something-else) -> 5c690b78d489f158d8575e7ed271521d056c445e8bd3978c8295775c1743bec0
  let result = sha256d('my-test-data', 'hex');
  expect(result).toBe('4f1ba9a4204e97a293b16ead6caced38f6d91d95618b96e261c6332ed24f7894');
  result = sha256d('something-else', 'hex');
  expect(result).toBe('5c690b78d489f158d8575e7ed271521d056c445e8bd3978c8295775c1743bec0');
});

test('buildAuthMessage concatenates timestamp||walletId||payload', () => {
  expect.hasAssertions();
  expect(buildAuthMessage(1700000000, 'wid', 'PAYLOAD')).toBe('1700000000widPAYLOAD');
});

test('verifyMessageSignature verifies a Hathor-signed arbitrary message against its address', () => {
  expect.hasAssertions();

  const xpriv = getXPrivKeyFromSeed(TEST_SEED, { passphrase: '', networkName: process.env.NETWORK });
  const key = walletUtils.deriveXpriv(xpriv, '0\'');
  const address = key.publicKey.toAddress(network.getNetwork()).toString();

  const message = buildAuthMessage(1700000000, 'wid', 'PAYLOAD');
  const signature = new bitcore.Message(message).sign(key.privateKey);

  expect(verifyMessageSignature(signature, message, address)).toBe(true);
  // tampering the message breaks verification
  expect(verifyMessageSignature(signature, `${message}x`, address)).toBe(false);
});

describe('verifyMessageSignature with the short signatures bitcore produces', () => {
  // Signed by bitcore with a fixed key (the private key 0xc0ffee…01), which
  // dropped the leading zero bytes of r.
  const address = 'HFzeNDCm5jc5aABuW96NooczNGX7FjZzin';
  const rShort64 = { message: 'fixture-388', signature: 'H6vnb0fgg6C5ZFJCos/xvKNyQKhJXUiRmqGu/1k4ZGpaXfbZ5aui3WcgjCQDXJF/ksJFdXamfdHEwF611lM2bQ==' };
  const rShort63 = { message: 'fixture-63', signature: 'II8uyiMU7ovwwDVJ5EL/IfdQ2PczK8byq8mYCqvpsBF4iBFyL/C2iyYkZflaPFguEgkUSg52YjuYqkk9g0Cg' };

  it.each([
    ['64 bytes (r one byte short)', rShort64],
    ['63 bytes (r two bytes short)', rShort63],
  ])('verifies a signature of %s', (_, { message, signature }) => {
    expect(Buffer.from(signature, 'base64').length).toBeLessThan(65);
    expect(verifyMessageSignature(signature, message, address)).toBe(true);
  });

  it('still rejects one against another address or message', () => {
    expect(verifyMessageSignature(rShort64.signature, rShort64.message, ADDRESSES[0])).toBe(false);
    expect(verifyMessageSignature(rShort64.signature, `${rShort64.message}x`, address)).toBe(false);
  });

  it.each([
    ['an empty', ''],
    ['a one-byte', Buffer.alloc(1, 31).toString('base64')],
    ['a too long', Buffer.alloc(66, 1).toString('base64')],
    ['a non-base64', '%%%'],
  ])('rejects %s signature without throwing', (_, signature) => {
    expect(verifyMessageSignature(signature, rShort64.message, address)).toBe(false);
  });
});

test('arrayShuffle', () => {
  expect.hasAssertions();
  const original = Array.from(Array(10).keys());

  const shuffled = Array.from(Array(10).keys());
  arrayShuffle(shuffled);

  expect(original).not.toStrictEqual(shuffled);
});

test('isTxVoided', async () => {
  expect.hasAssertions();

  const spy = jest.spyOn(Fullnode.default, 'downloadTx');

  const mockImplementation = jest.fn((txId) => {
    if (txId === '0000000f1fbb4bd8a8e71735af832be210ac9a6c1e2081b21faeea3c0f5797f7') {
      return {
        meta: {
          voided_by: [],
        },
      };
    }

    return {
      meta: {
        voided_by: ['0000000f1fbb4bd8a8e71735af832be210ac9a6c1e2081b21faeea3c0f5797f7'],
      },
    };
  });

  // @ts-ignore
  spy.mockImplementation(mockImplementation);

  expect(await isTxVoided('0000000f1fbb4bd8a8e71735af832be210ac9a6c1e2081b21faeea3c0f5797f7')).toStrictEqual([
    false,
    { meta: { voided_by: [] } },
  ]);
  expect(await isTxVoided('5c690b78d489f158d8575e7ed271521d056c445e8bd3978c8295775c1743bec0')).toStrictEqual([
    true,
    { meta: { voided_by: ['0000000f1fbb4bd8a8e71735af832be210ac9a6c1e2081b21faeea3c0f5797f7'] } },
  ]);
});

test('XPUBKEY, AUTH_XPUBKEY and ADDRESSES should be derived from TEST_SEED', async () => {
  expect.hasAssertions();
  const xpubkey = hathorLib.walletUtils.getXPubKeyFromSeed(TEST_SEED);
  expect(xpubkey).toStrictEqual(XPUBKEY);

  const authXpubkey = hathorLib.HathorWalletServiceWallet.getAuthXPubKeyFromSeed(TEST_SEED);
  expect(authXpubkey).toStrictEqual(AUTH_XPUBKEY);

  // Generate addresses in change derivation path 0
  const derivedXpub = hathorLib.walletUtils.xpubDeriveChild(xpubkey, 0);
  const addresses: string[] = [];
  for (let index = 0; index < 17; index++) {
    const addressInfo = hathorLib.addressUtils.deriveAddressFromXPubP2PKH(derivedXpub, index, 'mainnet');
    addresses.push(addressInfo.base58);
  }
  expect(addresses).toStrictEqual(ADDRESSES);
});
