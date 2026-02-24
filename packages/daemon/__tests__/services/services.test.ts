/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @jest-environment node
 */
import axios from 'axios';
import hathorLib from '@hathor/wallet-lib';
import {
  getDbConnection,
  getLastSyncedEvent,
  updateLastSyncedEvent as dbUpdateLastSyncedEvent,
  getTxOutputsFromTx,
  voidTransaction,
  voidAddressTransaction,
  getTransactionById,
  getUtxosLockedAtHeight,
  addOrUpdateTx,
  getAddressWalletInfo,
  storeTokenInformation,
  getMaxIndicesForWallets,
  addMiner,
  getLockedUtxoFromInputs,
  getTokensCreatedByTx,
  deleteTokens,
} from '../../src/db';
import {
  fetchInitialState,
  updateLastSyncedEvent,
  handleTxFirstBlock,
  handleVoidedTx,
  handleVertexAccepted,
  metadataDiff,
  handleReorgStarted,
  checkForMissedEvents,
  handleNcExecVoided,
} from '../../src/services';
import logger from '../../src/logger';
import {
  getAddressBalanceMap,
  prepareInputs,
  prepareOutputs,
  hashTxData,
  getFullnodeHttpUrl,
  invokeOnTxPushNotificationRequestedLambda,
  getWalletBalancesForTx,
  generateAddresses,
} from '../../src/utils';
import getConfig from '../../src/config';
import { addAlert, Severity } from '@wallet-service/common';
import { FullNodeEventTypes } from '../../src/types';
import { Context } from '../../src/types';
import { generateFullNodeEvent } from '../utils';

jest.mock('@hathor/wallet-lib');
jest.mock('../../src/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('axios', () => ({
  get: jest.fn(),
}));

jest.mock('../../src/db', () => ({
  getDbConnection: jest.fn(),
  getLastSyncedEvent: jest.fn(),
  updateLastSyncedEvent: jest.fn(),
  addOrUpdateTx: jest.fn(),
  getTxOutputsFromTx: jest.fn(),
  getTxOutput: jest.fn(),
  voidTransaction: jest.fn(),
  voidAddressTransaction: jest.fn(),
  voidWalletTransaction: jest.fn(),
  markUtxosAsVoided: jest.fn(),
  unspendUtxos: jest.fn(),
  clearTxProposalForVoidedTx: jest.fn(),
  dbUpdateLastSyncedEvent: jest.fn(),
  getTransactionById: jest.fn(),
  getUtxosLockedAtHeight: jest.fn(),
  unlockUtxos: jest.fn(),
  addMiner: jest.fn(),
  storeTokenInformation: jest.fn(),
  getLockedUtxoFromInputs: jest.fn(),
  addUtxos: jest.fn(),
  updateTxOutputSpentBy: jest.fn(),
  incrementTokensTxCount: jest.fn(),
  updateAddressTablesWithTx: jest.fn(),
  getAddressWalletInfo: jest.fn(),
  generateAddresses: jest.fn(),
  addNewAddresses: jest.fn(),
  updateWalletTablesWithTx: jest.fn(),
  getMaxIndicesForWallets: jest.fn(() => new Map([
    ['wallet1', { maxAmongAddresses: 10, maxWalletIndex: 15 }]
  ])),
  getTokensCreatedByTx: jest.fn(() => []),
  deleteTokens: jest.fn(),
  insertTokenCreation: jest.fn(),
}));

jest.mock('../../src/utils', () => ({
  prepareOutputs: jest.fn(),
  prepareInputs: jest.fn(),
  getAddressBalanceMap: jest.fn(),
  validateAddressBalances: jest.fn(),
  LRU: jest.fn(),
  unlockTimelockedUtxos: jest.fn(),
  markLockedOutputs: jest.fn(),
  getWalletBalanceMap: jest.fn(),
  hashTxData: jest.fn(),
  getTokenListFromInputsAndOutputs: jest.fn(),
  getUnixTimestamp: jest.fn(),
  unlockUtxos: jest.fn(),
  getFullnodeHttpUrl: jest.fn(),
  invokeOnTxPushNotificationRequestedLambda: jest.fn(),
  sendMessageSQS: jest.fn(),
  getWalletBalancesForTx: jest.fn(),
  generateAddresses: jest.fn(),
  retryWithBackoff: jest.fn((fn) => fn()),
}));

jest.mock('@wallet-service/common', () => {
  const addAlertMock = jest.fn();
  return {
    addAlert: addAlertMock,
    Severity: {
      INFO: 'INFO',
      MINOR: 'MINOR',
      MAJOR: 'MAJOR',
      CRITICAL: 'CRITICAL',
    },
    NftUtils: {
      shouldInvokeNftHandlerForTx: jest.fn().mockReturnValue(false),
      invokeNftHandlerLambda: jest.fn(),
      processNftEvent: jest.fn().mockReturnValue(Promise.resolve()),
    },
  };
});

jest.mock('../../src/config', () => {
  return {
    __esModule: true, // This property is needed for mocking a default export
    default: jest.fn(() => ({
      REORG_SIZE_INFO: 1,
      REORG_SIZE_MINOR: 3,
      REORG_SIZE_MAJOR: 5,
      REORG_SIZE_CRITICAL: 10,
    })),
    getConfig: jest.fn(() => ({
      REORG_SIZE_INFO: 1,
      REORG_SIZE_MINOR: 3,
      REORG_SIZE_MAJOR: 5,
      REORG_SIZE_CRITICAL: 10,
    })),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('fetchInitialState', () => {
  beforeEach(() => {
    const mockUrl = 'http://mock-host:8080/v1a/';
    (getFullnodeHttpUrl as jest.Mock).mockReturnValue(mockUrl);

    // @ts-ignore
    axios.get.mockResolvedValue({
      status: 200,
      data: {
        version: '0.58.0-rc.1',
        network: 'mainnet',
        min_weight: 14,
        min_tx_weight: 14,
        min_tx_weight_coefficient: 1.6,
        min_tx_weight_k: 100,
        token_deposit_percentage: 0.01,
        reward_spend_min_blocks: 300,
        max_number_inputs: 255,
        max_number_outputs: 255
      }
    });
  });

  it('should return the last event id', async () => {
    // Mock the return values of the dependencies
    const mockDb = { destroy: jest.fn() };

    // @ts-ignore
    getDbConnection.mockReturnValue(mockDb);
    // @ts-ignore
    getLastSyncedEvent.mockResolvedValue({
      id: 0,
      last_event_id: 123,
      updated_at: Date.now(),
    });

    const result = await fetchInitialState();

    expect(result).toEqual({
      lastEventId: 123,
      rewardMinBlocks: expect.any(Number),
    });
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should return the fullnode\'s reward spend min blocks', async () => {
    // Mock the return values of the dependencies
    const mockDb = { destroy: jest.fn() };

    // @ts-ignore
    getDbConnection.mockReturnValue(mockDb);
    // @ts-ignore
    getLastSyncedEvent.mockResolvedValue({
      id: 0,
      last_event_id: 123,
      updated_at: Date.now(),
    });

    const result = await fetchInitialState();

    expect(result).toEqual({
      lastEventId: expect.any(Number),
      rewardMinBlocks: 300,
    });

    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should not fail if reward spend min blocks is 0', async () => {
    // Mock the return values of the dependencies
    const mockDb = { destroy: jest.fn() };

    // @ts-ignore
    axios.get.mockResolvedValue({
      status: 200,
      data: {
        version: '0.58.0-rc.1',
        network: 'mainnet',
        min_weight: 14,
        min_tx_weight: 14,
        min_tx_weight_coefficient: 1.6,
        min_tx_weight_k: 100,
        token_deposit_percentage: 0.01,
        reward_spend_min_blocks: 0,
        max_number_inputs: 255,
        max_number_outputs: 255
      }
    });

    // @ts-ignore
    getDbConnection.mockReturnValue(mockDb);
    // @ts-ignore
    getLastSyncedEvent.mockResolvedValue({
      id: 0,
      last_event_id: 123,
      updated_at: Date.now(),
    });

    const result = await fetchInitialState();

    expect(result).toEqual({
      lastEventId: expect.any(Number),
      rewardMinBlocks: 0,
    });

    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should return undefined if no last event is found', async () => {
    const mockDb = { destroy: jest.fn() };
    // @ts-ignore
    getDbConnection.mockResolvedValue(mockDb);
    // @ts-ignore
    getLastSyncedEvent.mockResolvedValue(null);

    const result = await fetchInitialState();

    expect(result).toEqual({
      lastEventId: undefined,
      rewardMinBlocks: expect.any(Number),
    });
    expect(mockDb.destroy).toHaveBeenCalled();
  });
});

describe('updateLastSyncedEvent', () => {
  const mockDb = { destroy: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDbConnection as jest.Mock).mockResolvedValue(mockDb);
  });

  it('should update when the lastEventId is greater', async () => {
    (getLastSyncedEvent as jest.Mock).mockResolvedValue({ last_event_id: 100 });

    // @ts-ignore
    await updateLastSyncedEvent({ event: { event: { id: 101 } } });

    expect(dbUpdateLastSyncedEvent).toHaveBeenCalledWith(mockDb, 101);
    expect(mockDb.destroy).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('should log error and throw when the lastEventId is less than or equal', async () => {
    (getLastSyncedEvent as jest.Mock).mockResolvedValue({ last_event_id: 102 });

    // @ts-ignore
    await expect(updateLastSyncedEvent({ event: { event: { id: 100 } } })).rejects.toThrow('Event lower than stored one.');

    expect(dbUpdateLastSyncedEvent).not.toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('Tried to store an event lower than the one on the database', {
      lastEventId: 100,
      lastDbSyncedEvent: JSON.stringify({ last_event_id: 102 }),
    });
  });
});

describe('handleTxFirstBlock', () => {
  const mockDb = {
    beginTransaction: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    destroy: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDbConnection as jest.Mock).mockResolvedValue(mockDb);
  });

  it('should handle the tx first block successfully', async () => {
    const context = {
      event: {
        event: {
          data: {
            hash: 'hashValue',
            metadata: {
              height: 123,
              first_block: 'blockHash123',
            },
            timestamp: 'timestampValue',
            version: 'versionValue',
            weight: 'weightValue',
          },
          id: 'idValue',
        },
      },
    };

    await handleTxFirstBlock(context as any);

    expect(addOrUpdateTx).toHaveBeenCalledWith(mockDb, 'hashValue', 123, 'timestampValue', 'versionValue', 'weightValue', 'blockHash123');
    expect(dbUpdateLastSyncedEvent).toHaveBeenCalledWith(mockDb, 'idValue');
    expect(logger.debug).toHaveBeenCalledWith('Confirmed tx hashValue in block blockHash123: idValue');
    expect(mockDb.commit).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should handle tx going back to mempool (first_block is null)', async () => {
    const context = {
      event: {
        event: {
          data: {
            hash: 'hashValue',
            metadata: {
              height: 123, // This should be ignored when first_block is null
              first_block: null,
            },
            timestamp: 'timestampValue',
            version: 'versionValue',
            weight: 'weightValue',
          },
          id: 'idValue',
        },
      },
    };

    await handleTxFirstBlock(context as any);

    // When first_block is null, height should also be null
    expect(addOrUpdateTx).toHaveBeenCalledWith(mockDb, 'hashValue', null, 'timestampValue', 'versionValue', 'weightValue', null);
    expect(dbUpdateLastSyncedEvent).toHaveBeenCalledWith(mockDb, 'idValue');
    expect(logger.debug).toHaveBeenCalledWith('Tx hashValue back to mempool (first_block=null): idValue');
    expect(mockDb.commit).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should handle tx going back to mempool (first_block is undefined)', async () => {
    const context = {
      event: {
        event: {
          data: {
            hash: 'hashValue',
            metadata: {
              height: 123,
              // first_block is undefined
            },
            timestamp: 'timestampValue',
            version: 'versionValue',
            weight: 'weightValue',
          },
          id: 'idValue',
        },
      },
    };

    await handleTxFirstBlock(context as any);

    // When first_block is undefined (null), height should also be null
    expect(addOrUpdateTx).toHaveBeenCalledWith(mockDb, 'hashValue', null, 'timestampValue', 'versionValue', 'weightValue', null);
    expect(dbUpdateLastSyncedEvent).toHaveBeenCalledWith(mockDb, 'idValue');
    expect(logger.debug).toHaveBeenCalledWith('Tx hashValue back to mempool (first_block=null): idValue');
    expect(mockDb.commit).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should rollback on error and rethrow', async () => {
    (addOrUpdateTx as jest.Mock).mockRejectedValue(new Error('Test error'));

    const context = {
      event: {
        event: {
          data: {
            hash: 'hashValue',
            metadata: {
              height: 123,
              first_block: 'blockHash123',
            },
            timestamp: 'timestampValue',
            version: 'versionValue',
            weight: 'weightValue',
          },
          id: 'idValue',
        },
      },
    };

    await expect(handleTxFirstBlock(context as any)).rejects.toThrow('Test error');
    expect(logger.error).toHaveBeenCalledWith('E: ', expect.any(Error));
    expect(mockDb.rollback).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });
});

describe('handleVoidedTx', () => {
  const mockDb = {
    beginTransaction: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    destroy: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDbConnection as jest.Mock).mockResolvedValue(mockDb);
  });

  it('should handle the voided tx', async () => {
    const context = {
      event: {
        event: {
          data: {
            hash: 'hashValue',
            outputs: 'outputsValue',
            inputs: 'inputsValue',
            tokens: 'tokensValue',
          },
          id: 'idValue',
        },
      },
    };

    (prepareOutputs as jest.Mock).mockReturnValue([]);
    (prepareInputs as jest.Mock).mockReturnValue([]);
    (getAddressBalanceMap as jest.Mock).mockReturnValue({});
    (getTxOutputsFromTx as jest.Mock).mockResolvedValue([]);
    (getAddressWalletInfo as jest.Mock).mockResolvedValue({});

    await handleVoidedTx(context as any);

    expect(voidTransaction).toHaveBeenCalledWith(expect.any(Object), 'hashValue');
    expect(logger.debug).toHaveBeenCalledWith('Will handle voided tx for hashValue');
    expect(logger.debug).toHaveBeenCalledWith('Voided tx hashValue');
    expect(mockDb.beginTransaction).toHaveBeenCalled();
    expect(mockDb.commit).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should throw an error if transaction output is different from database output', async () => {
    const context = {
      event: {
        event: {
          data: {
            hash: 'hashValue',
            outputs: 'outputsValue',
            inputs: 'inputsValue',
            tokens: 'tokensValue',
          },
          id: 'idValue',
        },
      },
    };

    // Mock the return values
    const mockTxOutputs = [
      { index: 1, value: 5 },
      { index: 2, value: 10 },
    ];
    const mockDbTxOutputs = [
      { index: 1, value: 5, locked: false },
      // Omitting index 2 to create a mismatch
    ];

    (prepareOutputs as jest.Mock).mockReturnValue(mockTxOutputs);
    (getTxOutputsFromTx as jest.Mock).mockResolvedValue(mockDbTxOutputs);

    // Now, when handleVoidedTx is called, it should throw the error because of the mismatch
    await expect(handleVoidedTx(context as any)).rejects.toThrow('Transaction output different from database output!');
    expect(mockDb.rollback).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should rollback on error and rethrow', async () => {
    (getTxOutputsFromTx as jest.Mock).mockRejectedValue(new Error('Test error'));

    const context = {
      event: {
        event: {
          data: {
            hash: 'hashValue',
            outputs: 'outputsValue',
            inputs: 'inputsValue',
            tokens: 'tokensValue',
          },
          id: 'idValue',
        },
      },
    };

    await expect(handleVoidedTx(context as any)).rejects.toThrow('Test error');
    expect(logger.debug).toHaveBeenCalledWith(expect.any(Error));
    expect(mockDb.beginTransaction).toHaveBeenCalled();
    expect(mockDb.rollback).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });
});

describe('handleVertexAccepted', () => {
  const mockDb = {
    beginTransaction: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    destroy: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    (getDbConnection as jest.Mock).mockResolvedValue(mockDb);
    (getAddressWalletInfo as jest.Mock).mockResolvedValue({
      address1: { walletId: 'wallet1', xpubkey: 'xpubkey1', maxGap: 10 }
    });

    (generateAddresses as jest.Mock).mockResolvedValue({
      'new-address-1': 16,
      'new-address-2': 17,
    });

    (getMaxIndicesForWallets as jest.Mock).mockResolvedValue(new Map([
      ['wallet1', { maxAmongAddresses: 10, maxWalletIndex: 15 }]
    ]));
  });

  it('should handle vertex accepted successfully', async () => {
    const context = {
      event: {
        event: {
          data: {
            hash: 'hashValue',
            metadata: {
              height: 123,
              first_block: true,
              voided_by: [],
            },
            timestamp: 'timestampValue',
            version: 'versionValue',
            weight: 'weightValue',
            outputs: 'outputsValue',
            inputs: 'inputsValue',
            tokens: 'tokensValue',
            token_name: 'tokenName',
            token_symbol: 'tokenSymbol',
          },
          id: 'idValue',
        },
      },
      rewardMinBlocks: 300,
      txCache: {
        get: jest.fn(),
        set: jest.fn(),
      },
    };

    (addOrUpdateTx as jest.Mock).mockReturnValue(Promise.resolve());
    (getTransactionById as jest.Mock).mockResolvedValue(null); // Transaction is not in the database
    (prepareOutputs as jest.Mock).mockReturnValue([]);
    (prepareInputs as jest.Mock).mockReturnValue([]);
    (getAddressBalanceMap as jest.Mock).mockReturnValue({});
    (getUtxosLockedAtHeight as jest.Mock).mockResolvedValue([]);
    (hashTxData as jest.Mock).mockReturnValue('hashedData');
    (getAddressWalletInfo as jest.Mock).mockResolvedValue({
      'address1': {
        walletId: 'wallet1',
        xpubkey: 'xpubkey1',
        maxGap: 10
      },
    });

    await handleVertexAccepted(context as any, {} as any);

    expect(getDbConnection).toHaveBeenCalled();
    expect(mockDb.beginTransaction).toHaveBeenCalled();
    expect(getTransactionById).toHaveBeenCalledWith(mockDb, 'hashValue');
    expect(logger.debug).toHaveBeenCalledWith('Will add the tx with height', 123);
    expect(mockDb.commit).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should handle call the push notification lambda if PUSH_NOTIFICATION_ENABLED is true', async () => {
    const context = {
      event: {
        event: {
          data: {
            hash: 'hashValue',
            metadata: {
              height: 123,
              first_block: true,
              voided_by: [],
            },
            timestamp: new Date().getTime(),
            version: 1,
            weight: 17.17,
            outputs: [],
            inputs: [1],
            tokens: [],
          },
          id: 'idValue',
        },
      },
      rewardMinBlocks: 300,
      txCache: {
        get: jest.fn(),
        set: jest.fn(),
      },
    };

    (getConfig as jest.Mock).mockReturnValue({
      PUSH_NOTIFICATION_ENABLED: true,
      NEW_TX_SQS: 'http://nowhere.com',
    });

    (addOrUpdateTx as jest.Mock).mockReturnValue(Promise.resolve());
    (getTransactionById as jest.Mock).mockResolvedValue(null); // Transaction is not in the database
    (prepareOutputs as jest.Mock).mockReturnValue([]);
    (prepareInputs as jest.Mock).mockReturnValue([]);
    (getAddressBalanceMap as jest.Mock).mockReturnValue({});
    (getUtxosLockedAtHeight as jest.Mock).mockResolvedValue([]);
    (hashTxData as jest.Mock).mockReturnValue('hashedData');
    (getAddressWalletInfo as jest.Mock).mockResolvedValue({
      'address1': {
        walletId: 'wallet1',
        xpubkey: 'xpubkey1',
        maxGap: 10
      },
    });
    (getWalletBalancesForTx as jest.Mock).mockResolvedValue({ 'mockWallet': {} });
    (invokeOnTxPushNotificationRequestedLambda as jest.Mock).mockResolvedValue(undefined);

    await handleVertexAccepted(context as any, {} as any);

    expect(invokeOnTxPushNotificationRequestedLambda).toHaveBeenCalled();
    expect(mockDb.commit).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should handle token creation tx without storing token info (tokens created via TOKEN_CREATED event)', async () => {
    const tokenName = 'TEST_TOKEN';
    const tokenSymbol = 'TST_TKN';
    const hash = '000013f562dc216890f247688028754a49d21dbb2b1f7731f840dc65585b1d57';
    const context = {
      event: {
        event: {
          data: {
            hash,
            metadata: {
              height: 123,
              first_block: true,
              voided_by: [],
            },
            timestamp: 'timestampValue',
            version: 2,
            weight: 70,
            outputs: [],
            inputs: [],
            tokens: [],
            token_name: tokenName,
            token_symbol: tokenSymbol,
          },
          id: 5
        },
      },
      rewardMinBlocks: 300,
      txCache: {
        get: jest.fn(),
        set: jest.fn(),
      },
    };

    (addOrUpdateTx as jest.Mock).mockReturnValue(Promise.resolve());
    (getTransactionById as jest.Mock).mockResolvedValue(null); // Transaction is not in the database
    (prepareOutputs as jest.Mock).mockReturnValue([]);
    (prepareInputs as jest.Mock).mockReturnValue([]);
    (getAddressBalanceMap as jest.Mock).mockReturnValue({});
    (getUtxosLockedAtHeight as jest.Mock).mockResolvedValue([]);
    (hashTxData as jest.Mock).mockReturnValue('hashedData');
    (getAddressWalletInfo as jest.Mock).mockResolvedValue({
      'address1': {
        walletId: 'wallet1',
        xpubkey: 'xpubkey1',
        maxGap: 10
      },
    });

    await handleVertexAccepted(context as any, {} as any);

    expect(storeTokenInformation).not.toHaveBeenCalled();
    expect(mockDb.commit).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should rollback on error and rethrow', async () => {
    (getTransactionById as jest.Mock).mockRejectedValue(new Error('Test error'));

    const context = {
      rewardMinBlocks: 5,
      event: {
        event: {
          data: {
            hash: 'hashValue',
            outputs: 'outputsValue',
            inputs: 'inputsValue',
            tokens: 'tokensValue',
          },
          id: 'idValue',
        },
      },
    };

    await expect(handleVertexAccepted(context as any, {} as any)).rejects.toThrow('Test error');
    expect(mockDb.beginTransaction).toHaveBeenCalled();
    expect(mockDb.rollback).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should handle PoA blocks with empty outputs without crashing', async () => {
    // Mock hathorLib constants to recognize PoA block version
    const POA_BLOCK_VERSION = 5;
    (hathorLib as any).constants = {
      BLOCK_VERSION: 0,
      MERGED_MINED_BLOCK_VERSION: 3,
      POA_BLOCK_VERSION: POA_BLOCK_VERSION,
      CREATE_TOKEN_TX_VERSION: 2,
    };

    const context = {
      event: {
        event: {
          data: {
            hash: 'poaBlockHash',
            metadata: {
              height: 1,
              first_block: null,
              voided_by: [],
            },
            timestamp: 1762200490,
            version: POA_BLOCK_VERSION,
            weight: 2,
            outputs: [], // PoA blocks may have no outputs
            inputs: [],
            tokens: [],
            token_name: null,
            token_symbol: null,
            nonce: 0,
            parents: ['parent1', 'parent2', 'parent3'],
          },
          id: 5,
        },
      },
      rewardMinBlocks: 300,
    };

    (addOrUpdateTx as jest.Mock).mockReturnValue(Promise.resolve());
    (getTransactionById as jest.Mock).mockResolvedValue(null);
    (prepareOutputs as jest.Mock).mockReturnValue([]);
    (prepareInputs as jest.Mock).mockReturnValue([]);
    (getAddressBalanceMap as jest.Mock).mockReturnValue({});
    (getUtxosLockedAtHeight as jest.Mock).mockResolvedValue([]);
    (getLockedUtxoFromInputs as jest.Mock).mockResolvedValue([]);
    (getAddressWalletInfo as jest.Mock).mockResolvedValue({});

    await handleVertexAccepted(context as any, {} as any);

    // Verify addMiner was NOT called since there are no outputs
    expect(addMiner).not.toHaveBeenCalled();

    // Verify the transaction was still processed successfully (with firstBlock = null for PoA block)
    expect(addOrUpdateTx).toHaveBeenCalledWith(
      mockDb,
      'poaBlockHash',
      1, // height
      1762200490, // timestamp
      POA_BLOCK_VERSION,
      2, // weight
      null, // firstBlock
    );
    expect(mockDb.commit).toHaveBeenCalled();
    expect(mockDb.destroy).toHaveBeenCalled();
  });

  it('should pass first_block when inserting transaction', async () => {
    const context = {
      event: {
        event: {
          data: {
            hash: 'txHash123',
            metadata: {
              height: 50,
              first_block: 'blockHash456',
              voided_by: [],
            },
            timestamp: 1234567890,
            version: 1,
            weight: 17.5,
            outputs: [],
            inputs: [],
            tokens: [],
          },
          id: 'eventId123',
        },
      },
      rewardMinBlocks: 300,
      txCache: {
        get: jest.fn(),
        set: jest.fn(),
      },
    };

    (addOrUpdateTx as jest.Mock).mockReturnValue(Promise.resolve());
    (getTransactionById as jest.Mock).mockResolvedValue(null);
    (prepareOutputs as jest.Mock).mockReturnValue([]);
    (prepareInputs as jest.Mock).mockReturnValue([]);
    (getAddressBalanceMap as jest.Mock).mockReturnValue({});
    (getUtxosLockedAtHeight as jest.Mock).mockResolvedValue([]);
    (hashTxData as jest.Mock).mockReturnValue('hashedData');
    (getAddressWalletInfo as jest.Mock).mockResolvedValue({});

    await handleVertexAccepted(context as any, {} as any);

    // Verify firstBlock is passed to addOrUpdateTx
    expect(addOrUpdateTx).toHaveBeenCalledWith(
      mockDb,
      'txHash123',
      50,
      1234567890,
      1,
      17.5,
      'blockHash456', // firstBlock should be passed
    );
    expect(mockDb.commit).toHaveBeenCalled();
  });
});

describe('metadataDiff', () => {
  const mockDb = {
    destroy: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDbConnection as jest.Mock).mockResolvedValue(mockDb);
  });

  it('should ignore voided transactions not in database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: ['mockVoidedBy'], first_block: null },
          },
        },
      },
    };

    (getTransactionById as jest.Mock).mockResolvedValue(null);

    const result = await metadataDiff({} as any, event as any);

    expect(result.types).toEqual(['IGNORE']);
  });

  it('should handle new transactions', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: null },
          },
        },
      },
    };

    (getTransactionById as jest.Mock).mockResolvedValue(null);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['TX_NEW']);
  });

  it('should handle transaction voided but not voided in database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: ['mockVoidedBy'], first_block: null },
          },
        },
      },
    };
    const mockDbTransaction = { voided: false };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['TX_VOIDED']);
  });

  it('should ignore transaction voided and also voided in database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: ['mockVoidedBy'], first_block: null },
          },
        },
      },
    };
    const mockDbTransaction = { voided: true };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['IGNORE']);
  });

  it('should handle transaction with first_block but no first_block in database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: 'mockFirstBlock' },
          },
        },
      },
    };
    const mockDbTransaction = { height: null, first_block: null };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['TX_FIRST_BLOCK']);
  });

  it('should ignore transaction with first_block and same first_block in database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: 'mockFirstBlock' },
          },
        },
      },
    };
    const mockDbTransaction = { height: 1, first_block: 'mockFirstBlock' };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['IGNORE']);
  });

  it('should return TX_FIRST_BLOCK when transaction goes back to mempool (first_block changes to null)', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            // nc_execution is 'success' so NC_EXEC_VOIDED is not triggered
            metadata: { voided_by: [], first_block: '', nc_execution: 'success' }, // Empty string means null
          },
        },
      },
    };
    // Transaction was confirmed but now first_block is null
    const mockDbTransaction = { height: 10, first_block: 'originalBlock' };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['TX_FIRST_BLOCK']);
  });

  it('should return TX_FIRST_BLOCK when first_block changes to different block (reorg)', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            // nc_execution is 'success' so NC_EXEC_VOIDED is not triggered
            metadata: { voided_by: [], first_block: 'newBlock', nc_execution: 'success' },
          },
        },
      },
    };
    // Transaction was in one block, now it's in a different block
    const mockDbTransaction = { height: 10, first_block: 'oldBlock' };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['TX_FIRST_BLOCK']);
  });

  it('should ignore transaction with null first_block in both event and database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: null },
          },
        },
      },
    };
    // Transaction is in mempool in both
    const mockDbTransaction = { height: null, first_block: null };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['IGNORE']);
  });

  it('should return IGNORE when nc_execution is not success but no nano tokens exist', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: null, nc_execution: 'pending' },
          },
        },
      },
    };
    const mockDbTransaction = { height: null, voided: false };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);
    (getTokensCreatedByTx as jest.Mock).mockResolvedValue([]); // No tokens

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['IGNORE']);
  });

  it('should return IGNORE when nc_execution is success', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: null, nc_execution: 'success' },
          },
        },
      },
    };
    const mockDbTransaction = { height: null, voided: false };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['IGNORE']);
    // Should not call getTokensCreatedByTx when nc_execution is success
    expect(getTokensCreatedByTx).not.toHaveBeenCalled();
  });

  it('should return NC_EXEC_VOIDED when nc_execution changes from success and nano tokens exist', async () => {
    const txHash = 'nano-tx-hash';
    const event = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: null, nc_execution: 'pending' },
          },
        },
      },
    };
    const mockDbTransaction = { height: 1, voided: false };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);
    // Return nano-created tokens (token_id != tx_id)
    (getTokensCreatedByTx as jest.Mock).mockResolvedValue(['nano-token-001', 'nano-token-002']);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['NC_EXEC_VOIDED']);
    expect(getTokensCreatedByTx).toHaveBeenCalledWith(expect.anything(), txHash);
  });

  it('should return IGNORE when nc_execution is not success but only traditional tokens exist', async () => {
    const txHash = 'create-token-tx-hash';
    const event = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: null, nc_execution: 'pending' },
          },
        },
      },
    };
    const mockDbTransaction = { height: 1, voided: false };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);
    // Return only traditional token (token_id = tx_id)
    (getTokensCreatedByTx as jest.Mock).mockResolvedValue([txHash]);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['IGNORE']);
  });

  it('should return NC_EXEC_VOIDED for hybrid tx with both traditional and nano tokens', async () => {
    const txHash = 'hybrid-tx-hash';
    const event = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: null, nc_execution: 'pending' },
          },
        },
      },
    };
    const mockDbTransaction = { height: 1, voided: false };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);
    // Return both traditional (token_id = tx_id) and nano tokens
    (getTokensCreatedByTx as jest.Mock).mockResolvedValue([txHash, 'nano-token-001']);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['NC_EXEC_VOIDED']);
  });

  it('should return NC_EXEC_VOIDED when nc_execution is null and nano tokens exist', async () => {
    const txHash = 'nano-tx-hash';
    const event = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: null, nc_execution: null },
          },
        },
      },
    };
    const mockDbTransaction = { height: 1, voided: false };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);
    (getTokensCreatedByTx as jest.Mock).mockResolvedValue(['nano-token-001']);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['NC_EXEC_VOIDED']);
  });

  it('should return both NC_EXEC_VOIDED and TX_FIRST_BLOCK when both changed in the same event', async () => {
    // During a reorg, a single VERTEX_METADATA_CHANGED event can carry BOTH:
    //   1. nc_execution changing from 'success' to 'pending' (nano tokens must be deleted)
    //   2. first_block changing (tx moved to different block or back to mempool)
    // metadataDiff must detect all independent changes, not just the first one.
    const txHash = 'reorg-tx-hash';
    const event = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: null, nc_execution: 'pending' },
          },
        },
      },
    };
    // DB has first_block set, event has null → first_block changed
    const mockDbTransaction = { height: 1, voided: false, first_block: 'old-block' };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);
    (getTokensCreatedByTx as jest.Mock).mockResolvedValue(['nano-token-001']);

    const result = await metadataDiff({} as any, event as any);
    // Both changes must be detected — not just the first one
    expect(result.types).toEqual(['NC_EXEC_VOIDED', 'TX_FIRST_BLOCK']);
    expect(result.types).toHaveLength(2);
  });

  it('should handle errors and destroy the database connection', async () => {
    const event = {
      event: {
        event: {
          id: 123,
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: null },
          },
        },
      },
    };
    (getTransactionById as jest.Mock).mockRejectedValue(new Error('Mock Error'));

    await expect(metadataDiff({} as any, event as any)).rejects.toThrow('Mock Error');
    expect(mockDb.destroy).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('metadataDiff error', { eventId: 123, error: new Error('Mock Error') });
  });

  it('should handle transaction transactions that are not voided anymore', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: null },
          },
        },
      },
    };
    const mockDbTransaction = { voided: true }; // Indicate that the transaction was voided in the database.
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.types).toEqual(['TX_UNVOIDED']);
  });

  it('should detect full nano contract tx lifecycle: mempool → confirmed → reorg', async () => {
    const txHash = 'nc-lifecycle-tx';

    // Event 0: tx enters the mempool (nc_execution and first_block are null)
    // DB has no record → TX_NEW
    const event0 = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: null, nc_execution: null },
          },
        },
      },
    };
    (getTransactionById as jest.Mock).mockResolvedValue(null);

    const result0 = await metadataDiff({} as any, event0 as any);
    expect(result0.types).toEqual(['TX_NEW']);

    // Event 1: tx gets confirmed (first_block set, nc_execution goes to 'success')
    // DB has the tx from event 0: first_block = null
    const event1 = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: 'block-1', nc_execution: 'success' },
          },
        },
      },
    };
    (getTransactionById as jest.Mock).mockResolvedValue({
      voided: false,
      first_block: null,
    });

    const result1 = await metadataDiff({} as any, event1 as any);
    expect(result1.types).toEqual(['TX_FIRST_BLOCK']);

    // Event 2: reorg — tx loses first_block and nc_execution reverts to null
    // DB reflects the state after event 1: confirmed with first_block
    const event2 = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: null, nc_execution: null },
          },
        },
      },
    };
    (getTransactionById as jest.Mock).mockResolvedValue({
      voided: false,
      first_block: 'block-1',
    });
    (getTokensCreatedByTx as jest.Mock).mockResolvedValue(['nano-token-1']);

    const result2 = await metadataDiff({} as any, event2 as any);
    // Both changes detected: nano tokens must be deleted AND first_block must be updated
    expect(result2.types).toEqual(['NC_EXEC_VOIDED', 'TX_FIRST_BLOCK']);
  });

  it('should detect voided tx becoming unvoided', async () => {
    const txHash = 'unvoided-lifecycle-tx';

    // Event 0: tx enters the mempool
    // DB has no record → TX_NEW
    const event0 = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: null, nc_execution: null },
          },
        },
      },
    };
    (getTransactionById as jest.Mock).mockResolvedValue(null);

    const result0 = await metadataDiff({} as any, event0 as any);
    expect(result0.types).toEqual(['TX_NEW']);

    // Event 1: tx gets voided (conflict)
    // DB has the tx from event 0, not voided
    const event1 = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: ['conflicting-tx'], first_block: null, nc_execution: null },
          },
        },
      },
    };
    (getTransactionById as jest.Mock).mockResolvedValue({
      voided: false,
      first_block: null,
    });

    const result1 = await metadataDiff({} as any, event1 as any);
    expect(result1.types).toEqual(['TX_VOIDED']);

    // Event 2: tx gets unvoided (conflict resolved)
    // DB has the tx marked as voided
    const event2 = {
      event: {
        event: {
          data: {
            hash: txHash,
            metadata: { voided_by: [], first_block: null, nc_execution: null },
          },
        },
      },
    };
    (getTransactionById as jest.Mock).mockResolvedValue({
      voided: true,
      first_block: null,
    });

    const result2 = await metadataDiff({} as any, event2 as any);
    // TX_UNVOIDED is mutually exclusive — the machine chains into handlingVertexAccepted to re-add the tx
    expect(result2.types).toEqual(['TX_UNVOIDED']);
  });
});

describe('handleReorgStarted', () => {
  beforeEach(() => {
    (getConfig as jest.Mock).mockReturnValue({
      REORG_SIZE_INFO: 1,
      REORG_SIZE_MINOR: 3,
      REORG_SIZE_MAJOR: 5,
      REORG_SIZE_CRITICAL: 10,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should add INFO alert when reorg size equals REORG_SIZE_INFO', async () => {
    const event = generateFullNodeEvent({
      type: FullNodeEventTypes.REORG_STARTED,
      data: {
        reorg_size: 1,
        previous_best_block: 'prev',
        new_best_block: 'new',
        common_block: 'common',
      },
    });

    // @ts-ignore
    await handleReorgStarted({ event } as Context);

    expect(addAlert).toHaveBeenCalledWith(
      'Reorg Detected',
      'A reorg of size 1 has occurred.',
      Severity.INFO,
      {
        reorg_size: 1,
        previous_best_block: 'prev',
        new_best_block: 'new',
        common_block: 'common',
      },
      expect.anything(),
    );
  });

  it('should add MINOR alert when reorg size is between REORG_SIZE_MINOR and REORG_SIZE_MAJOR', async () => {
    const event = generateFullNodeEvent({
      type: FullNodeEventTypes.REORG_STARTED,
      data: {
        reorg_size: 3,
        previous_best_block: 'prev',
        new_best_block: 'new',
        common_block: 'common',
      },
    });

    // @ts-ignore
    await handleReorgStarted({ event } as Context);

    expect(addAlert).toHaveBeenCalledWith(
      'Minor Reorg Detected',
      'A minor reorg of size 3 has occurred.',
      Severity.MINOR,
      {
        reorg_size: 3,
        previous_best_block: 'prev',
        new_best_block: 'new',
        common_block: 'common',
      },
      expect.anything(),
    );
  });

  it('should add MAJOR alert when reorg size is between REORG_SIZE_MAJOR and REORG_SIZE_CRITICAL', async () => {
    const event = generateFullNodeEvent({
      type: FullNodeEventTypes.REORG_STARTED,
      data: {
        reorg_size: 7,
        previous_best_block: 'prev',
        new_best_block: 'new',
        common_block: 'common',
      },
    });

    // @ts-ignore
    await handleReorgStarted({ event } as Context);

    expect(addAlert).toHaveBeenCalledWith(
      'Major Reorg Detected',
      'A major reorg of size 7 has occurred.',
      Severity.MAJOR,
      {
        reorg_size: 7,
        previous_best_block: 'prev',
        new_best_block: 'new',
        common_block: 'common',
      },
      expect.anything(),
    );
  });

  it('should add CRITICAL alert when reorg size is greater than REORG_SIZE_CRITICAL', async () => {
    const event = generateFullNodeEvent({
      type: FullNodeEventTypes.REORG_STARTED,
      data: {
        reorg_size: 11,
        previous_best_block: 'prev',
        new_best_block: 'new',
        common_block: 'common',
      },
    });

    // @ts-ignore
    await handleReorgStarted({ event } as Context);

    expect(addAlert).toHaveBeenCalledWith(
      'Critical Reorg Detected',
      'A critical reorg of size 11 has occurred.',
      Severity.CRITICAL,
      {
        reorg_size: 11,
        previous_best_block: 'prev',
        new_best_block: 'new',
        common_block: 'common',
      },
      expect.anything(),
    );
  });

  it('should not add alert when reorg size is less than REORG_SIZE_INFO', async () => {
    const event = generateFullNodeEvent({
      type: FullNodeEventTypes.REORG_STARTED,
      data: {
        reorg_size: 0,
        previous_best_block: 'prev',
        new_best_block: 'new',
        common_block: 'common',
      },
    });

    // @ts-ignore
    await handleReorgStarted({ event } as Context);

    expect(addAlert).not.toHaveBeenCalled();
  });

  it('should throw error when event is missing', async () => {
    await expect(handleReorgStarted({} as Context))
      .rejects
      .toThrow('No event in context');
  });

  it('should throw error when event type is incorrect', async () => {
    const event = generateFullNodeEvent({
      type: FullNodeEventTypes.VERTEX_METADATA_CHANGED,
      data: {},
    });

    // @ts-ignore
    await expect(handleReorgStarted({ event } as Context))
      .rejects
      .toThrow('Invalid event type for REORG_STARTED');
  });
});

describe('checkForMissedEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const mockUrl = 'http://mock-host:8080/v1a';
    (getFullnodeHttpUrl as jest.Mock).mockReturnValue(mockUrl);
  });

  it('should return hasNewEvents=true when API returns events', async () => {
    const mockResponse = {
      status: 200,
      data: {
        events: [
          {
            id: 115182,
            timestamp: 1761758848.1938324,
            type: 'VERTEX_METADATA_CHANGED',
            data: { hash: 'mockHash' },
          },
          {
            id: 115183,
            timestamp: 1761758848.196779,
            type: 'NEW_VERTEX_ACCEPTED',
            data: { hash: 'mockHash' },
          },
        ],
        latest_event_id: 115561,
      },
    };

    (axios.get as jest.Mock).mockResolvedValue(mockResponse);

    const context = {
      event: {
        event: {
          id: 115181,
        },
      },
    };

    const result = await checkForMissedEvents(context as any);

    expect(result.hasNewEvents).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(axios.get).toHaveBeenCalledWith('http://mock-host:8080/v1a/event', {
      params: {
        last_ack_event_id: 115181,
        size: 1,
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Detected 2 missed event(s) after ACK 115181. Will reconnect.'
    );
  });

  it('should return hasNewEvents=false when API returns no events', async () => {
    const mockResponse = {
      status: 200,
      data: {
        events: [],
        latest_event_id: 115181,
      },
    };

    (axios.get as jest.Mock).mockResolvedValue(mockResponse);

    const context = {
      event: {
        event: {
          id: 115181,
        },
      },
    };

    const result = await checkForMissedEvents(context as any);

    expect(result.hasNewEvents).toBe(false);
    expect(result.events).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(
      'No missed events detected after ACK 115181'
    );
  });

  it('should throw error when HTTP request fails', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      status: 500,
      data: {},
    });

    const context = {
      event: {
        event: {
          id: 115181,
        },
      },
    };

    await expect(checkForMissedEvents(context as any))
      .rejects
      .toThrow('Failed to check for missed events: HTTP 500');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 500')
    );
  });

  it('should throw error when network request fails', async () => {
    const networkError = new Error('ECONNREFUSED: Connection refused');
    (axios.get as jest.Mock).mockRejectedValue(networkError);

    const context = {
      event: {
        event: {
          id: 115181,
        },
      },
    };

    await expect(checkForMissedEvents(context as any))
      .rejects
      .toThrow('Failed to check for missed events: Network error');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Network error')
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ECONNREFUSED')
    );
  });

  it('should throw error when context has no event', async () => {
    const context = {};

    await expect(checkForMissedEvents(context as any))
      .rejects
      .toThrow('No event in context when checking for missed events');
  });

  it('should handle API response with non-array events field', async () => {
    const mockResponse = {
      status: 200,
      data: {
        events: null,
        latest_event_id: 115181,
      },
    };

    (axios.get as jest.Mock).mockResolvedValue(mockResponse);

    const context = {
      event: {
        event: {
          id: 115181,
        },
      },
    };

    const result = await checkForMissedEvents(context as any);

    expect(result.hasNewEvents).toBe(false);
  });

  it('should throw error when response data is invalid', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: null,
    });

    const context = {
      event: {
        event: {
          id: 115181,
        },
      },
    };

    await expect(checkForMissedEvents(context as any))
      .rejects
      .toThrow('Failed to check for missed events: Invalid response structure');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid response data structure')
    );
  });
});

describe('handleNcExecVoided', () => {
  const mockDb = {
    beginTransaction: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    destroy: jest.fn(),
  };

  const createContext = (txHash: string, firstBlock: string | null = null) => ({
    event: {
      event: {
        id: 100,
        data: {
          hash: txHash,
          metadata: { first_block: firstBlock },
        },
      },
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (getDbConnection as jest.Mock).mockResolvedValue(mockDb);
  });

  it('should not delete any tokens when no tokens exist for the transaction', async () => {
    const txHash = 'tx-without-tokens';
    const context = createContext(txHash);

    (getTokensCreatedByTx as jest.Mock).mockResolvedValue([]);

    await handleNcExecVoided(context as any);

    expect(getTokensCreatedByTx).toHaveBeenCalledWith(mockDb, txHash);
    expect(deleteTokens).not.toHaveBeenCalled();
    expect(addOrUpdateTx).not.toHaveBeenCalled();
    expect(mockDb.commit).toHaveBeenCalled();
  });

  it('should delete only nano-created tokens when tokens exist', async () => {
    const txHash = 'nano-tx-hash';
    const nanoToken1 = 'nano-token-001';
    const nanoToken2 = 'nano-token-002';
    const context = createContext(txHash);

    (getTokensCreatedByTx as jest.Mock).mockResolvedValue([nanoToken1, nanoToken2]);

    await handleNcExecVoided(context as any);

    expect(deleteTokens).toHaveBeenCalledWith(mockDb, [nanoToken1, nanoToken2]);
    expect(addOrUpdateTx).not.toHaveBeenCalled();
    expect(mockDb.commit).toHaveBeenCalled();
  });

  it('should NOT delete traditional CREATE_TOKEN_TX tokens (where token_id = tx_id)', async () => {
    const txHash = 'create-token-tx-hash';
    const context = createContext(txHash);

    (getTokensCreatedByTx as jest.Mock).mockResolvedValue([txHash]);

    await handleNcExecVoided(context as any);

    expect(deleteTokens).not.toHaveBeenCalled();
    expect(mockDb.commit).toHaveBeenCalled();
  });

  it('should delete nano tokens but keep traditional token in hybrid transaction', async () => {
    const txHash = 'hybrid-tx-hash';
    const nanoToken = 'nano-created-token';
    const context = createContext(txHash);

    (getTokensCreatedByTx as jest.Mock).mockResolvedValue([txHash, nanoToken]);

    await handleNcExecVoided(context as any);

    expect(deleteTokens).toHaveBeenCalledWith(mockDb, [nanoToken]);
    expect(mockDb.commit).toHaveBeenCalled();
  });

  it('should rollback on error and rethrow', async () => {
    const txHash = 'error-tx-hash';
    const context = createContext(txHash);

    const error = new Error('Database error');
    (getTokensCreatedByTx as jest.Mock).mockRejectedValue(error);

    await expect(handleNcExecVoided(context as any)).rejects.toThrow('Database error');

    expect(mockDb.rollback).toHaveBeenCalled();
    expect(mockDb.commit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('handleNcExecVoided error: ', error);
  });
});
