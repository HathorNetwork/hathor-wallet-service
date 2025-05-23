import { arrayShuffle, sha256d, isTxVoided } from '@src/utils';
import hathorLib from '@hathor/wallet-lib';
import * as Fullnode from '@src/fullnode';
import { TEST_SEED, XPUBKEY, AUTH_XPUBKEY, ADDRESSES } from '@tests/utils';

test('sha256d', () => {
  expect.hasAssertions();
  // sha256d(my-test-data) -> 4f1ba9a4204e97a293b16ead6caced38f6d91d95618b96e261c6332ed24f7894
  // sha256d(something-else) -> 5c690b78d489f158d8575e7ed271521d056c445e8bd3978c8295775c1743bec0
  let result = sha256d('my-test-data', 'hex');
  expect(result).toBe('4f1ba9a4204e97a293b16ead6caced38f6d91d95618b96e261c6332ed24f7894');
  result = sha256d('something-else', 'hex');
  expect(result).toBe('5c690b78d489f158d8575e7ed271521d056c445e8bd3978c8295775c1743bec0');
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
