// @ts-ignore: Using old wallet-lib version, no types exported
import hathorLib from '@hathor/wallet-lib';
import { mockedAddAlert } from './alerting.utils.mock';
import { Severity } from '@src/types';
import { NftUtils } from '@src/utils/nft.utils';
import { getHandlerContext, getTransaction } from '../events/nftCreationTx';
import {
  LambdaClient as LambdaClientMock,
  InvokeCommandOutput,
} from '@aws-sdk/client-lambda';
import { Logger } from 'winston';

jest.mock('winston', () => {
  class FakeLogger {
    warn() {
      return jest.fn();
    }
    error() {
      return jest.fn();
    }
    info() {
      return jest.fn();
    }
  };

  return {
    Logger: FakeLogger,
  }
});

jest.mock('@aws-sdk/client-lambda', () => {
  const mLambda = { send: jest.fn() };
  const mInvokeCommand = jest.fn();
  return {
    LambdaClient: jest.fn(() => mLambda),
    InvokeCommand: mInvokeCommand,
  };
});

const network = new hathorLib.Network('testnet');
const logger = new Logger();

describe('shouldInvokeNftHandlerForTx', () => {
  it('should return false for a NFT transaction if the feature is disabled', () => {
    expect.hasAssertions();

    // Preparation
    const tx = getTransaction();
    const isNftTransaction = NftUtils.isTransactionNFTCreation(tx, network, logger);
    expect(isNftTransaction).toStrictEqual(true);

    expect(process.env.NFT_AUTO_REVIEW_ENABLED).not.toStrictEqual('true');

    // Execution
    // @ts-ignore
    const result = NftUtils.shouldInvokeNftHandlerForTx(tx, network, logger);

    // Assertion
    expect(result).toBe(false);
  });

  it('should return true for a NFT transaction if the feature is enabled', () => {
    expect.hasAssertions();

    // Preparation
    const tx = getTransaction();
    const isNftTransaction = NftUtils.isTransactionNFTCreation(tx, network, logger);
    expect(isNftTransaction).toStrictEqual(true);

    const oldValue = process.env.NFT_AUTO_REVIEW_ENABLED;
    process.env.NFT_AUTO_REVIEW_ENABLED = 'true';

    // Execution
    const result = NftUtils.shouldInvokeNftHandlerForTx(tx, network, logger);

    // Assertion
    expect(result).toBe(true);

    // Tearing Down
    process.env.NFT_AUTO_REVIEW_ENABLED = oldValue;
  });
});

describe('isTransactionNFTCreation', () => {
  it('should return false on quick validations', () => {
    expect.hasAssertions();

    // Preparing mocks
    const spyCreateTx = jest.spyOn(hathorLib.helpersUtils, 'createTxFromHistoryObject');
    spyCreateTx.mockImplementation(() => ({}));
    let tx;
    let result;

    // Incorrect version
    tx = getTransaction();
    tx.version = hathorLib.constants.DEFAULT_TX_VERSION;
    result = NftUtils.isTransactionNFTCreation(tx, network, logger);
    expect(result).toBe(false);
    expect(spyCreateTx).not.toHaveBeenCalled();

    // Missing name
    tx = getTransaction();
    tx.token_name = undefined;
    result = NftUtils.isTransactionNFTCreation(tx, network, logger);
    expect(result).toBe(false);
    expect(spyCreateTx).not.toHaveBeenCalled();

    // Missing symbol
    tx = getTransaction();
    tx.token_symbol = undefined;
    result = NftUtils.isTransactionNFTCreation(tx, network, logger);
    expect(result).toBe(false);
    expect(spyCreateTx).not.toHaveBeenCalled();

    // Reverting mocks
    spyCreateTx.mockRestore();
  });

  it('should return true when the wallet-lib validation does not fail', () => {
    expect.hasAssertions();

    // Preparing mocks
    const spyNftValidation = jest.spyOn(hathorLib.CreateTokenTransaction.prototype, 'validateNft');
    spyNftValidation.mockImplementation(() => undefined);

    // Validation
    const tx = getTransaction();
    const result = NftUtils.isTransactionNFTCreation(tx, network, logger);
    expect(result).toBe(true);

    // Reverting mocks
    spyNftValidation.mockRestore();
  });

  it('should return true when the wallet-lib validation does not fail (unmocked)', () => {
    expect.hasAssertions();

    // Validation
    const tx = getTransaction();
    const result = NftUtils.isTransactionNFTCreation(tx, network, logger);
    expect(result).toBe(true);
  });

  it('should return false when the wallet-lib validation throws', () => {
    expect.hasAssertions();

    // Preparing mocks
    const spyNftValidation = jest.spyOn(hathorLib.CreateTokenTransaction.prototype, 'validateNft');
    spyNftValidation.mockImplementation(() => {
      throw new Error('not a nft');
    });

    // Validation
    const tx = getTransaction();
    // @ts-ignore
    const result = NftUtils.isTransactionNFTCreation(tx, network, logger);
    expect(result).toBe(false);

    // Reverting mocks
    spyNftValidation.mockRestore();
  });
});

describe('createOrUpdateNftMetadata', () => {
  const spyUpdateMetadata = jest.spyOn(NftUtils, '_updateMetadata');

  afterEach(() => {
    spyUpdateMetadata.mockReset();
  });

  afterAll(() => {
    // Clear mocks
    spyUpdateMetadata.mockRestore();
  });

  it('should request the create/update metadata with minimum nft data', async () => {
    expect.hasAssertions();
    const expectedUpdateRequest = { id: 'sampleUid', nft: true };
    const expectedUpdateResponse = { updated: 'ok' };

    spyUpdateMetadata.mockImplementation(async () => expectedUpdateResponse);
    const result = await NftUtils.createOrUpdateNftMetadata('sampleUid', 5, logger);

    expect(spyUpdateMetadata).toHaveBeenCalledTimes(1);

    expect(spyUpdateMetadata).toHaveBeenCalledWith('sampleUid', expectedUpdateRequest, 5, logger);
    expect(result).toBeUndefined(); // The method returns void
  });
});

describe('_updateMetadata', () => {
  it('should return the update lambda response on success', async () => {
    expect.hasAssertions();

    // Building the mock lambda
    const expectedLambdaResponse = {
      StatusCode: 202,
      Payload: 'sampleData',
    };

    const mLambdaClient = new LambdaClientMock({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mLambdaClient.send as jest.Mocked<any>).mockImplementation(
      async () => Promise.resolve(expectedLambdaResponse),
    );
    const oldStage = process.env.STAGE;
    process.env.STAGE = 'dev'; // Testing all code branches, including the developer ones, for increased coverage

    const result = await NftUtils._updateMetadata('sampleUid', { sampleData: 'fake' }, 5, logger);
    expect(result).toStrictEqual(expectedLambdaResponse);
    process.env.STAGE = oldStage;
  });

  it('should retry calling the update lambda a set number of times', async () => {
    expect.hasAssertions();

    // Building the mock lambda
    let failureCount = 0;
    const expectedLambdaResponse = {
      StatusCode: 202,
      Payload: 'sampleData',
    };
    const mLambdaClient = new LambdaClientMock({});
    (mLambdaClient.send as jest.Mocked<any>).mockImplementation(async () => {
        if (failureCount < 4) {
          ++failureCount;
          return {
            StatusCode: 500,
            Payload: 'failurePayload',
          };
        }
        return expectedLambdaResponse;
    });

    const result = await NftUtils._updateMetadata('sampleUid', { sampleData: 'fake' }, 5, logger);
    expect(result).toStrictEqual(expectedLambdaResponse);
  });

  it('should throw after reaching retry count', async () => {
    expect.hasAssertions();

    // Building the mock lambda
    let failureCount = 0;
    const mLambdaClient = new LambdaClientMock({});
    (mLambdaClient.send as jest.Mocked<any>).mockImplementation(() => {
      if (failureCount < 5) {
        ++failureCount;
        return {
          StatusCode: 500,
          Payload: 'failurePayload',
        };
      }
      return {
        StatusCode: 202,
        Payload: 'sampleData',
      };
    });

    // eslint-disable-next-line jest/valid-expect
    expect(NftUtils._updateMetadata('sampleUid', { sampleData: 'fake' }, network, logger))
      .rejects.toThrow(new Error('Metadata update failed for tx_id: sampleUid.'));
  });
});

describe('invokeNftHandlerLambda', () => {
  it('should return the lambda response on success', async () => {
    expect.hasAssertions();

    // Building the mock lambda
    const expectedLambdaResponse: InvokeCommandOutput = {
      StatusCode: 202,
      $metadata: {}
    };
    const mLambdaClient = new LambdaClientMock({});
    (mLambdaClient.send as jest.Mocked<any>).mockImplementationOnce(async () => expectedLambdaResponse);

    await expect(NftUtils.invokeNftHandlerLambda('sampleUid', 'local')).resolves.toBeUndefined();
  });

  it('should throw when payload response status is invalid', async () => {
    expect.hasAssertions();

    // Building the mock lambda
    const mLambdaClient = new LambdaClientMock({});
    const expectedLambdaResponse: InvokeCommandOutput = {
      StatusCode: 500,
      $metadata: {}
    };
    (mLambdaClient.send as jest.Mocked<any>).mockImplementation(() => expectedLambdaResponse);

    await expect(NftUtils.invokeNftHandlerLambda('sampleUid', 'local'))
      .rejects.toThrow(new Error('onNewNftEvent lambda invoke failed for tx: sampleUid'));

    expect(mockedAddAlert).toHaveBeenCalledWith(
      'Error on NFTHandler lambda',
      'Erroed on invokeNftHandlerLambda invocation',
      Severity.MINOR,
      { TxId: 'sampleUid' },
    );
  });
});

describe('minor helpers', () => {
  it('should generate an event context', () => {
    expect.hasAssertions();

    const c = getHandlerContext();
    expect(c.done()).toBeUndefined();
    expect(c.fail('fail')).toBeUndefined();
    expect(c.getRemainingTimeInMillis()).toStrictEqual(0);
    expect(c.succeed('pass')).toBeUndefined();
  });
});
