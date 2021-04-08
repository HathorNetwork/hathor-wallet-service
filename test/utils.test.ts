/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @jest-environment node
 */
import {
  OUR_BEST_BLOCK_API_RESPONSE_VOIDED,
  OUR_BEST_BLOCK_API_RESPONSE,
  BLOCK_BY_HEIGHT,
  MOCK_TXS,
  MOCK_FULL_TXS,
  generateBlock,
} from './utils';
import * as Utils from '../src/utils';
const { syncToLatestBlock } = Utils;

beforeAll(async () => {
  jest.clearAllMocks();
});

test('syncToLatestBlockGen should yield an error when the latest block from the wallet-service is_voided', async () => {
  expect.hasAssertions();

  const getFullNodeBestBlockSpy = jest.spyOn(Utils, 'getFullNodeBestBlock');
  const getWalletServiceBestBlockSpy = jest.spyOn(Utils, 'getWalletServiceBestBlock');
  const getBlockByTxIdSpy = jest.spyOn(Utils, 'getBlockByTxId');
  const downloadBlockByHeightSpy = jest.spyOn(Utils, 'downloadBlockByHeight');

  getFullNodeBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[0], 1)));
  getWalletServiceBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[1], 0)));
  getBlockByTxIdSpy.mockReturnValue(Promise.resolve(OUR_BEST_BLOCK_API_RESPONSE_VOIDED));
  downloadBlockByHeightSpy.mockReturnValue(Promise.resolve(BLOCK_BY_HEIGHT));

  const iterator = syncToLatestBlock();

  const { value: { type, success, message } } = await iterator.next();

  expect(type).toStrictEqual('error');
  expect(success).toStrictEqual(false);
  expect(message).toStrictEqual('Our best block was voided, we should reorg.');
}, 500);

test('syncToLatestBlockGen should yield an error when our best block height is higher than the fullnode\'s', async () => {
  expect.hasAssertions();

  const getFullNodeBestBlockSpy = jest.spyOn(Utils, 'getFullNodeBestBlock');
  const getWalletServiceBestBlockSpy = jest.spyOn(Utils, 'getWalletServiceBestBlock');
  const getBlockByTxIdSpy = jest.spyOn(Utils, 'getBlockByTxId');
  const downloadBlockByHeightSpy = jest.spyOn(Utils, 'downloadBlockByHeight');

  getWalletServiceBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[1], 6)));
  getFullNodeBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[0], 3)));
  getBlockByTxIdSpy.mockReturnValue(Promise.resolve(OUR_BEST_BLOCK_API_RESPONSE_VOIDED));
  downloadBlockByHeightSpy.mockReturnValue(Promise.resolve(BLOCK_BY_HEIGHT));

  const iterator = syncToLatestBlock();

  const { value: { type, success, message } } = await iterator.next();

  expect(type).toStrictEqual('error');
  expect(success).toStrictEqual(false);
  expect(message).toStrictEqual('Our best block was voided, we should reorg.');
}, 500);

test('syncToLatestBlockGen should yield an error when it fails to send a block', async () => {
  expect.hasAssertions();

  const getFullNodeBestBlockSpy = jest.spyOn(Utils, 'getFullNodeBestBlock');
  const getWalletServiceBestBlockSpy = jest.spyOn(Utils, 'getWalletServiceBestBlock');
  const getBlockByTxIdSpy = jest.spyOn(Utils, 'getBlockByTxId');
  const sendTxSpy = jest.spyOn(Utils, 'sendTx');
  const downloadBlockByHeightSpy = jest.spyOn(Utils, 'downloadBlockByHeight');
  const recursivelyDownloadTxSpy = jest.spyOn(Utils, 'recursivelyDownloadTx');

  getWalletServiceBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[1], 3)));
  getFullNodeBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[0], 6)));
  getBlockByTxIdSpy.mockReturnValue(Promise.resolve(OUR_BEST_BLOCK_API_RESPONSE));
  sendTxSpy.mockReturnValue(Promise.resolve({ success: false, message: 'generic error message' }));
  downloadBlockByHeightSpy.mockReturnValue(Promise.resolve(BLOCK_BY_HEIGHT));
  recursivelyDownloadTxSpy.mockReturnValue(Promise.resolve([]));

  const iterator = syncToLatestBlock();

  const { value: { type, success, message } } = await iterator.next();

  expect(type).toStrictEqual('error');
  expect(success).toStrictEqual(false);
  expect(message).toStrictEqual('Failure on block 0000000f1fbb4bd8a8e71735af832be210ac9a6c1e2081b21faeea3c0f5797f7');
}, 500);

test('syncToLatestBlockGen should yield an error when it fails to send a transaction', async () => {
  expect.hasAssertions();

  const getFullNodeBestBlockSpy = jest.spyOn(Utils, 'getFullNodeBestBlock');
  const getWalletServiceBestBlockSpy = jest.spyOn(Utils, 'getWalletServiceBestBlock');
  const getBlockByTxIdSpy = jest.spyOn(Utils, 'getBlockByTxId');
  const sendTxSpy = jest.spyOn(Utils, 'sendTx');
  const downloadBlockByHeightSpy = jest.spyOn(Utils, 'downloadBlockByHeight');
  const recursivelyDownloadTxSpy = jest.spyOn(Utils, 'recursivelyDownloadTx');

  getWalletServiceBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[1], 3)));
  getFullNodeBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[0], 6)));
  getBlockByTxIdSpy.mockReturnValue(Promise.resolve(OUR_BEST_BLOCK_API_RESPONSE));
  // sendTxSpy.mockReturnValue(Promise.resolve({ success: false, message: 'generic error message' }));
  downloadBlockByHeightSpy.mockReturnValue(Promise.resolve(BLOCK_BY_HEIGHT));
  recursivelyDownloadTxSpy.mockReturnValue(Promise.resolve([MOCK_FULL_TXS[0]]));

  const mockSendTxImplementation = jest.fn((tx) => {
    if (tx.height) {
      // is block
      return Promise.resolve({
        success: true,
      });
    }

    // is tx
    return Promise.resolve({
      success: false,
      message: 'generic send tx error message',
    });
  });

  sendTxSpy.mockImplementation(mockSendTxImplementation);

  const iterator = syncToLatestBlock();

  const { value: { type, success, message } } = await iterator.next();

  expect(type).toStrictEqual('transaction_failure');
  expect(success).toStrictEqual(false);
  expect(message).toStrictEqual('Failure on transaction 0000000033a3bb347e0401d85a70b38f0aa7b5e37ea4c70d7dacf8e493946e64 from block: 0000000f1fbb4bd8a8e71735af832be210ac9a6c1e2081b21faeea3c0f5797f7');
}, 500);

test('syncToLatestBlockGen should sync from our current height until the best block height', async () => {
  expect.hasAssertions();

  const getFullNodeBestBlockSpy = jest.spyOn(Utils, 'getFullNodeBestBlock');
  const getWalletServiceBestBlockSpy = jest.spyOn(Utils, 'getWalletServiceBestBlock');
  const getBlockByTxIdSpy = jest.spyOn(Utils, 'getBlockByTxId');
  const sendTxSpy = jest.spyOn(Utils, 'sendTx');
  const downloadBlockByHeightSpy = jest.spyOn(Utils, 'downloadBlockByHeight');
  const recursivelyDownloadTxSpy = jest.spyOn(Utils, 'recursivelyDownloadTx');

  getWalletServiceBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[1], 1)));
  getFullNodeBestBlockSpy.mockReturnValue(Promise.resolve(generateBlock(MOCK_TXS[0], 3)));
  getBlockByTxIdSpy.mockReturnValue(Promise.resolve(OUR_BEST_BLOCK_API_RESPONSE));
  sendTxSpy.mockReturnValue(Promise.resolve({ success: true, message: 'ok' }));
  recursivelyDownloadTxSpy.mockReturnValue(Promise.resolve([]));

  const mockBlockHeightImplementation = jest.fn((height: number) => {
    return Promise.resolve({
      ...BLOCK_BY_HEIGHT,
      height
    });
  });

  downloadBlockByHeightSpy.mockImplementationOnce(mockBlockHeightImplementation);

  const iterator = syncToLatestBlock();

  const y1 = await iterator.next();
  expect(y1.value.success).toStrictEqual(true);
  expect(y1.value.height).toStrictEqual(2);
  expect(y1.value.type).toStrictEqual('block_success');

  const y2 = await iterator.next();
  expect(y2.value.success).toStrictEqual(true);
  expect(y2.value.height).toStrictEqual(3);
  expect(y2.value.type).toStrictEqual('block_success');

  const { value } = await iterator.next();
  expect(value.success).toStrictEqual(true);
  expect(value.type).toStrictEqual('finished');
}, 500);
