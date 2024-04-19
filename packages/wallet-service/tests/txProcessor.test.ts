/* eslint-disable @typescript-eslint/no-empty-function */
import * as txProcessor from '@src/txProcessor';
import { NftUtils } from '@wallet-service/common/src/utils/nft.utils';
import { getHandlerContext, nftCreationTx } from '@wallet-service/common/__tests__/events/nftCreationTx';

const defaultLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}

jest.mock('@src/logger', () => ({
  __esModule: true,
  default: () => defaultLogger,
}));

describe('NFT metadata updating', () => {
  const spyUpdateMetadata = jest.spyOn(NftUtils, '_updateMetadata');

  afterEach(() => {
    spyUpdateMetadata.mockReset();
  });

  afterAll(() => {
    // Clear mocks
    spyUpdateMetadata.mockRestore();
  });

  it('should reject a call for a missing mandatory parameter', async () => {
    expect.hasAssertions();

    spyUpdateMetadata.mockImplementation(async () => ({ updated: 'ok' }));

    await expect(txProcessor.onNewNftEvent(
      { nftUid: '' },
      getHandlerContext(),
      () => '',
    )).rejects.toThrow('Missing mandatory parameter nftUid');
    expect(spyUpdateMetadata).toHaveBeenCalledTimes(0);
  });

  it('should request update with minimum NFT data', async () => {
    expect.hasAssertions();

    spyUpdateMetadata.mockImplementation(async () => ({ updated: 'ok' }));

    const result = await txProcessor.onNewNftEvent(
      { nftUid: nftCreationTx.tx_id },
      getHandlerContext(),
      () => '',
    );
    expect(spyUpdateMetadata).toHaveBeenCalledTimes(1);
    expect(spyUpdateMetadata).toHaveBeenCalledWith(nftCreationTx.tx_id, { id: nftCreationTx.tx_id, nft: true }, txProcessor.CREATE_NFT_MAX_RETRIES, expect.objectContaining({
      error: expect.any(Function),
      info: expect.any(Function),
      warn: expect.any(Function),
      defaultMeta: {
        requestId: expect.any(String)
      },
    }));
    expect(result).toStrictEqual({ success: true });
  });

  it('should return a standardized message on nft validation failure', async () => {
    expect.hasAssertions();

    const spyCreateOrUpdate = jest.spyOn(NftUtils, 'createOrUpdateNftMetadata');
    spyCreateOrUpdate.mockImplementation(() => {
      throw new Error('Failure on validation');
    });

    const result = await txProcessor.onNewNftEvent(
      { nftUid: nftCreationTx.tx_id },
      getHandlerContext(),
      () => '',
    );

    const expectedResult = {
      success: false,
      message: `onNewNftEvent failed for token ${nftCreationTx.tx_id}`,
    };
    expect(result).toStrictEqual(expectedResult);
    expect(spyCreateOrUpdate).toHaveBeenCalledWith(nftCreationTx.tx_id, txProcessor.CREATE_NFT_MAX_RETRIES, expect.objectContaining({
      error: expect.any(Function),
      info: expect.any(Function),
      warn: expect.any(Function),
      defaultMeta: {
        requestId: expect.any(String)
      },
    }));

    spyCreateOrUpdate.mockReset();
    spyCreateOrUpdate.mockRestore();
  });
});
