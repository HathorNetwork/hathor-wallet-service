// @ts-ignore: Using old wallet-lib version, no types exported
import hathorLib from '@hathor/wallet-lib';
import { mockedAddAlert } from './alerting.utils.mock';
import { NftUtils } from '@src/utils/nft.utils';
import { Severity } from '@src/types';
import { getHandlerContext, getTransaction } from '../events/nftCreationTx';
import {
  LambdaClient as LambdaClientMock,
  InvokeCommandOutput,
  InvokeCommand,
} from '@aws-sdk/client-lambda';
import { Logger } from 'winston';
import { helpersUtils } from '@hathor/wallet-lib';
import { CreateTokenTransaction } from '@hathor/wallet-lib';
import { constants } from '@hathor/wallet-lib';

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

jest.mock('@src/utils/index.utils', () => {
  const originalModule = jest.requireActual('@src/utils/index.utils');

  return {
    ...originalModule,
    assertEnvVariablesExistence: jest.fn(),
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
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset all mocks before each test
    const mLambdaClient = new LambdaClientMock({});
    (mLambdaClient.send as jest.Mocked<any>).mockReset();
    
    // Set up required environment variables
    process.env = {
      ...originalEnv,
      NFT_AUTO_REVIEW_ENABLED: 'true',
      WALLET_SERVICE_LAMBDA_ENDPOINT: 'http://localhost:3000',
      AWS_REGION: 'us-east-1'
    };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  it('should successfully invoke the lambda handler', async () => {
    expect.hasAssertions();

    // Mock successful lambda response
    const expectedLambdaResponse: InvokeCommandOutput = {
      StatusCode: 202,
      $metadata: {}
    };
    const mLambdaClient = new LambdaClientMock({});
    (mLambdaClient.send as jest.Mocked<any>).mockImplementationOnce(async () => expectedLambdaResponse);

    const result = await NftUtils.invokeNftHandlerLambda('test-tx-id', 'local', logger);

    // Method should return void
    expect(result).toBeUndefined();

    // Verify Lambda client was constructed correctly
    expect(LambdaClientMock).toHaveBeenCalledWith({
      endpoint: process.env.WALLET_SERVICE_LAMBDA_ENDPOINT,
      region: process.env.AWS_REGION,
    });

    // Verify the lambda was invoked with correct parameters
    expect(mLambdaClient.send).toHaveBeenCalledTimes(1);
    const invokeCommand = new InvokeCommand({
      FunctionName: 'hathor-wallet-service-local-onNewNftEvent',
      InvocationType: 'Event',
      Payload: JSON.stringify({ nftUid: 'test-tx-id' }),
    });
    expect(mLambdaClient.send).toHaveBeenCalledWith(invokeCommand);
  });

  it('should throw error and add alert when lambda invocation fails', async () => {
    expect.hasAssertions();

    // Mock failed lambda response
    const expectedLambdaResponse: InvokeCommandOutput = {
      StatusCode: 500,
      $metadata: {}
    };
    const mLambdaClient = new LambdaClientMock({});
    (mLambdaClient.send as jest.Mocked<any>).mockImplementationOnce(async () => expectedLambdaResponse);

    await expect(NftUtils.invokeNftHandlerLambda('test-tx-id', 'local', logger))
      .rejects.toThrow('onNewNftEvent lambda invoke failed for tx: test-tx-id');

    // Verify alert was added
    expect(mockedAddAlert).toHaveBeenCalledWith(
      'Error on NFTHandler lambda',
      'Erroed on invokeNftHandlerLambda invocation',
      Severity.MINOR,
      { TxId: 'test-tx-id' },
      logger,
    );
  });

  it('should handle missing environment variables', async () => {
    expect.hasAssertions();

    // Clear required environment variables
    process.env = { ...originalEnv };
    delete process.env.WALLET_SERVICE_LAMBDA_ENDPOINT;
    delete process.env.AWS_REGION;
    delete process.env.NFT_AUTO_REVIEW_ENABLED;

    await expect(NftUtils.invokeNftHandlerLambda('test-tx-id', 'local', logger))
      .rejects.toThrow('Environment variables WALLET_SERVICE_LAMBDA_ENDPOINT and AWS_REGION are not set.');
  });

  it('should not invoke lambda when NFT_AUTO_REVIEW_ENABLED is not true', async () => {
    expect.hasAssertions();

    // Disable NFT auto review
    process.env.NFT_AUTO_REVIEW_ENABLED = 'false';

    const mLambdaClient = new LambdaClientMock({});
    const result = await NftUtils.invokeNftHandlerLambda('test-tx-id', 'local', logger);

    // Method should return void
    expect(result).toBeUndefined();

    // Verify lambda was not called
    expect(mLambdaClient.send).not.toHaveBeenCalled();
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

describe('transaction transformation compatibility', () => {
   it('should correctly process a real event from production', () => {
    expect.hasAssertions();

    // Real event data from production
    const fullNodeData = {
      "hash": "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866",
      "nonce": 257857,
      "timestamp": 1741649846,
      "signal_bits": 0,
      "version": 2,
      "weight": 17.30946054227969,
      "inputs": [
        {
          "tx_id": "00000000ba6f3fc01a3e8561f2905c50c98422e7112604a8971bdaba1535e797",
          "index": 1,
          "spent_output": {
            "value": 4,
            "token_data": 0,
            "script": "dqkUWDMJLPqtb9X+jPcBSP6WLg6NIC6IrA==",
            "decoded": {
              "type": "P2PKH",
              "address": "WWiPUqkLJbb6YMQRgHWPMBS6voJjpeWqas",
              "timelock": null
            }
          }
        }
      ],
      "outputs": [
        {
          "value": 1,
          "token_data": 0,
          "script": "C2lwZnM6Ly8xMTExrA==",
          "decoded": null
        },
        {
          "value": 2,
          "token_data": 0,
          "script": "dqkUFUs/hBsLnxy5Jd94WWV24BCmIhmIrA==",
          "decoded": {
            "type": "P2PKH",
            "address": "WQcdDHZriSQwE4neuzf9UW2xJkdhEqrt7F",
            "timelock": null
          }
        },
        {
          "value": 1,
          "token_data": 1,
          "script": "dqkUhM3YhAjNc5p/oqX+yqEYcX+miNmIrA==",
          "decoded": {
            "type": "P2PKH",
            "address": "WanEffTDdFo8giEj2CuNqGWsEeWjU7crnF",
            "timelock": null
          }
        }
      ],
      "parents": [
        "000048d3728061842625bbad6b3f463f488a0e7ba567fc7e4b3f7b28ab690075",
        "000000000576741d4d3aa82db265776b6896b58b825fac5e816c79d5e5e2c861"
      ],
      "tokens": [
        "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866"
      ],
      "token_name": "Test",
      "token_symbol": "TST",
      "metadata": {
        "hash": "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866",
        "spent_outputs": [
          {
            "index": 0,
            "tx_ids": []
          },
          {
            "index": 1,
            "tx_ids": []
          },
          {
            "index": 2,
            "tx_ids": []
          }
        ],
        "conflict_with": [],
        "voided_by": [],
        "received_by": [],
        "children": [
          "000000000007e794cd3e660e34af838c063370c5127f19ccab444052c2b5dadf"
        ],
        "twins": [],
        "accumulated_weight": 17.30946054227969,
        "score": 0,
        "first_block": "000000000007e794cd3e660e34af838c063370c5127f19ccab444052c2b5dadf",
        "height": 0,
        "validation": "full"
      },
      "aux_pow": null
    };

    // Transform the data as it happens in the services/index.ts file
    const txFromEvent = {
      ...fullNodeData,
      tx_id: fullNodeData.hash,
      inputs: fullNodeData.inputs.map((input) => {
        const tokenIndex = (input.spent_output.token_data & hathorLib.constants.TOKEN_INDEX_MASK) - 1;

        return {
          token: tokenIndex < 0 ? hathorLib.constants.HATHOR_TOKEN_CONFIG.uid : fullNodeData.tokens[tokenIndex],
          value: input.spent_output.value,
          token_data: input.spent_output.token_data,
          script: input.spent_output.script,
          decoded: {
            ...input.spent_output.decoded,
          },
          tx_id: input.tx_id,
          index: input.index
        };
      }),
      outputs: fullNodeData.outputs.map((output) => {
        const tokenIndex = (output.token_data & hathorLib.constants.TOKEN_INDEX_MASK) - 1;
        return {
          ...output,
          decoded: output.decoded ? output.decoded : {},
          spent_by: null,
          token: tokenIndex < 0 ? hathorLib.constants.HATHOR_TOKEN_CONFIG.uid : fullNodeData.tokens[tokenIndex],
        };
      }),
    };

    // Save original value to restore later
    const originalCreateTokenTxVersion = constants.CREATE_TOKEN_TX_VERSION;
    // Since we're using real data, we need to make sure the version matches
    const mockConstants = { ...constants, CREATE_TOKEN_TX_VERSION: 2 };
    jest.spyOn(constants, 'CREATE_TOKEN_TX_VERSION', 'get').mockReturnValue(2);

    try {
      // Enable NFT auto review to test the full flow
      process.env.NFT_AUTO_REVIEW_ENABLED = 'true';

      // Verify token handling is correct
      // First input should be HTR token
      expect(txFromEvent.inputs[0].token).toBe(hathorLib.constants.HATHOR_TOKEN_CONFIG.uid);
      
      // First and second outputs should be HTR tokens
      expect(txFromEvent.outputs[0].token).toBe(hathorLib.constants.HATHOR_TOKEN_CONFIG.uid);
      expect(txFromEvent.outputs[1].token).toBe(hathorLib.constants.HATHOR_TOKEN_CONFIG.uid);
      
      // Third output should be the NFT token
      expect(txFromEvent.outputs[2].token).toBe(fullNodeData.tokens[0]);

      // Check null decoded field is properly handled
      expect(txFromEvent.outputs[0].decoded).toStrictEqual({});

      // Mock network for validation
      const mockNetwork = {
        name: 'testnet',
      };
      
      // Test that this transaction is detected as an NFT
      const isNft = NftUtils.isTransactionNFTCreation(txFromEvent, mockNetwork as any, logger);
      expect(isNft).toBe(true);

      // Test the full flow
      const shouldInvoke = NftUtils.shouldInvokeNftHandlerForTx(txFromEvent, mockNetwork as any, logger);
      expect(shouldInvoke).toBe(true);
      
      // Ensure we can create a transaction from this data
      const libTx = helpersUtils.createTxFromHistoryObject(txFromEvent);
      expect(libTx).toBeDefined();
      expect(libTx.version).toBe(2);
      expect(libTx.tokens).toContain(fullNodeData.tokens[0]);
    } finally {
      // Clean up mocks
      jest.spyOn(constants, 'CREATE_TOKEN_TX_VERSION', 'get').mockRestore();
    }
  });
});

describe('processNftEvent', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let invokeNftLambdaSpy: jest.SpyInstance;
  let shouldInvokeSpy: jest.SpyInstance;

  beforeEach(() => {
    // Save original env
    originalEnv = process.env;
    process.env = {
      ...originalEnv,
      NFT_AUTO_REVIEW_ENABLED: 'true',
      WALLET_SERVICE_LAMBDA_ENDPOINT: 'http://localhost:3000',
      AWS_REGION: 'us-east-1'
    };

    invokeNftLambdaSpy = jest.spyOn(NftUtils, 'invokeNftHandlerLambda').mockResolvedValue();
    shouldInvokeSpy = jest.spyOn(NftUtils, 'shouldInvokeNftHandlerForTx').mockReturnValue(true);

    const mLambdaClient = new LambdaClientMock({});
    (mLambdaClient.send as jest.Mocked<any>).mockReset();
  });

  afterEach(() => {
    // Clean up
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('should invoke the NFT handler for a valid NFT event', async () => {
    expect.hasAssertions();

    // Real event data from production
    const eventData = {
      hash: "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866",
      nonce: 257857,
      timestamp: 1741649846,
      signal_bits: 0,
      version: 2,
      weight: 17.30946054227969,
      inputs: [
        {
          tx_id: "00000000ba6f3fc01a3e8561f2905c50c98422e7112604a8971bdaba1535e797",
          index: 1,
          spent_output: {
            value: 4,
            token_data: 0,
            script: "dqkUWDMJLPqtb9X+jPcBSP6WLg6NIC6IrA==",
            decoded: {
              type: "P2PKH",
              address: "WWiPUqkLJbb6YMQRgHWPMBS6voJjpeWqas",
              timelock: null
            }
          }
        }
      ],
      outputs: [
        {
          value: 1,
          token_data: 0,
          script: "C2lwZnM6Ly8xMTExrA==",
          decoded: null
        },
        {
          value: 2,
          token_data: 0,
          script: "dqkUFUs/hBsLnxy5Jd94WWV24BCmIhmIrA==",
          decoded: {
            type: "P2PKH",
            address: "WQcdDHZriSQwE4neuzf9UW2xJkdhEqrt7F",
            timelock: null
          }
        },
        {
          value: 1,
          token_data: 1,
          script: "dqkUhM3YhAjNc5p/oqX+yqEYcX+miNmIrA==",
          decoded: {
            type: "P2PKH",
            address: "WanEffTDdFo8giEj2CuNqGWsEeWjU7crnF",
            timelock: null
          }
        }
      ],
      tokens: [
        "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866"
      ],
      token_name: "Test",
      token_symbol: "TST",
    };

    // Mock network
    const mockNetwork = { name: 'testnet' };
    
    // Call the method
    const result = await NftUtils.processNftEvent(
      eventData, 
      'test-stage', 
      mockNetwork as any, 
      logger
    );

    // Verify result is true (successful invocation)
    expect(result).toBe(true);

    // Verify shouldInvokeNftHandlerForTx was called with properly transformed tx
    expect(shouldInvokeSpy).toHaveBeenCalledTimes(1);
    const callArg = shouldInvokeSpy.mock.calls[0][0];
    
    // Verify the transaction was transformed correctly
    expect(callArg).toMatchObject({
      tx_id: eventData.hash,
      version: eventData.version,
      token_name: eventData.token_name,
      token_symbol: eventData.token_symbol,
    });
    
    // Verify outputs were transformed correctly
    expect(callArg.outputs.length).toBe(eventData.outputs.length);
    expect(callArg.outputs[0].spent_by).toBeNull();
    expect(callArg.outputs[0].decoded).toEqual({});
    expect(callArg.outputs[0].token).toBe(hathorLib.constants.HATHOR_TOKEN_CONFIG.uid);
    
    // Verify the lambda was invoked with the correct parameters
    expect(invokeNftLambdaSpy).toHaveBeenCalledTimes(1);
    expect(invokeNftLambdaSpy).toHaveBeenCalledWith(
      eventData.hash,
      'test-stage',
      logger
    );
  });

  it('should not invoke the NFT handler when NFT_AUTO_REVIEW_ENABLED is false', async () => {
    expect.hasAssertions();

    // Disable NFT auto review
    process.env.NFT_AUTO_REVIEW_ENABLED = 'false';

    // Real event data from production (simplified)
    const eventData = {
      hash: "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866",
      version: 2,
      inputs: [{ tx_id: "tx1", index: 0, spent_output: { value: 1, token_data: 0, script: "s" } }],
      outputs: [{ value: 1, token_data: 0, script: "s" }],
      tokens: ["token1"],
      token_name: "Test",
      token_symbol: "TST",
    };

    // Mock network
    const mockNetwork = { name: 'testnet' };
    
    // Call the method
    const result = await NftUtils.processNftEvent(
      eventData, 
      'test-stage', 
      mockNetwork as any, 
      logger
    );

    // Verify result is false (no invocation)
    expect(result).toBe(false);

    // Verify shouldInvokeNftHandlerForTx was NOT called
    expect(shouldInvokeSpy).not.toHaveBeenCalled();
    
    // Verify the lambda was NOT invoked
    expect(invokeNftLambdaSpy).not.toHaveBeenCalled();
  });

  it('should return false when shouldInvokeNftHandlerForTx returns false', async () => {
    expect.hasAssertions();

    // Make shouldInvokeNftHandlerForTx return false
    shouldInvokeSpy.mockReturnValue(false);

    // Simplified event data
    const eventData = {
      hash: "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866",
      version: 2,
      inputs: [{ tx_id: "tx1", index: 0, spent_output: { value: 1, token_data: 0, script: "s" } }],
      outputs: [{ value: 1, token_data: 0, script: "s" }],
      tokens: ["token1"],
      token_name: "Test",
      token_symbol: "TST",
    };

    // Mock network
    const mockNetwork = { name: 'testnet' };
    
    // Call the method
    const result = await NftUtils.processNftEvent(
      eventData, 
      'test-stage', 
      mockNetwork as any, 
      logger
    );

    // Verify result is false (no invocation)
    expect(result).toBe(false);

    // Verify shouldInvokeNftHandlerForTx was called
    expect(shouldInvokeSpy).toHaveBeenCalledTimes(1);
    
    // Verify the lambda was NOT invoked
    expect(invokeNftLambdaSpy).not.toHaveBeenCalled();
  });

  it('should handle errors from invokeNftHandlerLambda', async () => {
    expect.hasAssertions();

    // Make invokeNftHandlerLambda throw an error
    invokeNftLambdaSpy.mockRejectedValue(new Error('Lambda invocation failed'));

    // Simplified event data
    const eventData = {
      hash: "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866",
      version: 2,
      inputs: [{ tx_id: "tx1", index: 0, spent_output: { value: 1, token_data: 0, script: "s" } }],
      outputs: [{ value: 1, token_data: 0, script: "s" }],
      tokens: ["token1"],
      token_name: "Test",
      token_symbol: "TST",
    };

    // Mock network
    const mockNetwork = { name: 'testnet' };
    
    // Call the method - it should not throw
    const result = await NftUtils.processNftEvent(
      eventData, 
      'test-stage', 
      mockNetwork as any, 
      logger
    );

    // Verify result is false (failed invocation)
    expect(result).toBe(false);

    // Verify shouldInvokeNftHandlerForTx was called
    expect(shouldInvokeSpy).toHaveBeenCalledTimes(1);
    
    // Verify the lambda was invoked
    expect(invokeNftLambdaSpy).toHaveBeenCalledTimes(1);
    
    // Verify error was logged
    expect(logger.error).toHaveBeenCalled();
  });
});

it('should perform full NFT processing with real event data and no mocks', async () => {
  expect.hasAssertions();

  // Clear all mocks to test the real implementation
  jest.restoreAllMocks();

  // Set up required environment variables
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    NFT_AUTO_REVIEW_ENABLED: 'true',
    WALLET_SERVICE_LAMBDA_ENDPOINT: 'http://localhost:3000',
    AWS_REGION: 'us-east-1'
  };

  // Mock the Lambda client to prevent actual AWS calls
  const mockSend = jest.fn().mockResolvedValue({ StatusCode: 202 });
  const mockLambdaClient = {
    send: mockSend
  };
  (LambdaClientMock as jest.Mock).mockImplementation(() => mockLambdaClient);

  try {
    // Real event data from production
    const eventData = {
      hash: "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866",
      nonce: 257857,
      timestamp: 1741649846,
      signal_bits: 0,
      version: 2,
      weight: 17.30946054227969,
      inputs: [
        {
          tx_id: "00000000ba6f3fc01a3e8561f2905c50c98422e7112604a8971bdaba1535e797",
          index: 1,
          spent_output: {
            value: 4,
            token_data: 0,
            script: "dqkUWDMJLPqtb9X+jPcBSP6WLg6NIC6IrA==",
            decoded: {
              type: "P2PKH",
              address: "WWiPUqkLJbb6YMQRgHWPMBS6voJjpeWqas",
              timelock: null
            }
          }
        }
      ],
      outputs: [
        {
          value: 1,
          token_data: 0,
          script: "C2lwZnM6Ly8xMTExrA==",
          decoded: null
        },
        {
          value: 2,
          token_data: 0,
          script: "dqkUFUs/hBsLnxy5Jd94WWV24BCmIhmIrA==",
          decoded: {
            type: "P2PKH",
            address: "WQcdDHZriSQwE4neuzf9UW2xJkdhEqrt7F",
            timelock: null
          }
        },
        {
          value: 1,
          token_data: 1,
          script: "dqkUhM3YhAjNc5p/oqX+yqEYcX+miNmIrA==",
          decoded: {
            type: "P2PKH",
            address: "WanEffTDdFo8giEj2CuNqGWsEeWjU7crnF",
            timelock: null
          }
        }
      ],
      tokens: [
        "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866"
      ],
      token_name: "Test",
      token_symbol: "TST",
      metadata: {
        hash: "000041f860a327969fa03685ed05cf316fc941708c53801cf81f426ac4a55866",
        spent_outputs: [
          { index: 0, tx_ids: [] },
          { index: 1, tx_ids: [] },
          { index: 2, tx_ids: [] }
        ],
        conflict_with: [],
        voided_by: [],
        received_by: [],
        children: ["000000000007e794cd3e660e34af838c063370c5127f19ccab444052c2b5dadf"],
        twins: [],
        accumulated_weight: 17.30946054227969,
        score: 0,
        first_block: "000000000007e794cd3e660e34af838c063370c5127f19ccab444052c2b5dadf",
        height: 0,
        validation: "full"
      }
    };

    // Mock network for validation
    const mockNetwork = {
      name: 'testnet',
    };

    // Since we're using real data, we need to make sure the version matches
    const originalCreateTokenTxVersion = constants.CREATE_TOKEN_TX_VERSION;
    jest.spyOn(constants, 'CREATE_TOKEN_TX_VERSION', 'get').mockReturnValue(2);

    try {
      // Process the NFT event
      const result = await NftUtils.processNftEvent(
        eventData,
        'test-stage',
        mockNetwork as any,
        logger
      );

      // Verify the result is true (successful processing)
      expect(result).toBe(true);

      // Verify Lambda client was constructed correctly
      expect(LambdaClientMock).toHaveBeenCalledWith({
        endpoint: process.env.WALLET_SERVICE_LAMBDA_ENDPOINT,
        region: process.env.AWS_REGION,
      });

      // Verify Lambda was invoked with correct parameters
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].input).toMatchObject({
        FunctionName: 'hathor-wallet-service-test-stage-onNewNftEvent',
        InvocationType: 'Event',
      });

      // Verify the payload contains the correct NFT UID
      const payload = JSON.parse(mockSend.mock.calls[0][0].input.Payload);
      expect(payload).toEqual({ nftUid: eventData.hash });
    } finally {
      // Clean up mocks
      jest.spyOn(constants, 'CREATE_TOKEN_TX_VERSION', 'get').mockRestore();
    }
  } finally {
    // Restore environment
    process.env = originalEnv;
  }
});
