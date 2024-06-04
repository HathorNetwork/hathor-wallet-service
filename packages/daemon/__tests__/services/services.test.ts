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
import {
  getDbConnection,
  getLastSyncedEvent,
  updateLastSyncedEvent as dbUpdateLastSyncedEvent,
  getTxOutputsFromTx,
  voidTransaction,
  getTransactionById,
  getUtxosLockedAtHeight,
  addOrUpdateTx,
  getAddressWalletInfo,
  generateAddresses,
} from '../../src/db';
import {
  fetchInitialState,
  updateLastSyncedEvent,
  handleTxFirstBlock,
  handleVoidedTx,
  handleVertexAccepted,
  metadataDiff,
} from '../../src/services';
import logger from '../../src/logger';
import {
  getAddressBalanceMap,
  prepareInputs,
  prepareOutputs,
  hashTxData,
  getFullnodeHttpUrl,
} from '../../src/utils';

jest.mock('@hathor/wallet-lib');
jest.mock('../../src/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
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
  voidTransaction: jest.fn(),
  markUtxosAsVoided: jest.fn(),
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
}));

jest.mock('@wallet-service/common', () => ({
  assertEnvVariablesExistence: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('fetchInitialState', () => {
  beforeAll(() => {
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
              first_block: ['hash2'],
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

    expect(addOrUpdateTx).toHaveBeenCalledWith(mockDb, 'hashValue', 123, 'timestampValue', 'versionValue', 'weightValue');
    expect(dbUpdateLastSyncedEvent).toHaveBeenCalledWith(mockDb, 'idValue');
    expect(logger.debug).toHaveBeenCalledWith('Confirmed tx hashValue: idValue');
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
              first_block: ['hash2'],
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

    await handleVoidedTx(context as any);

    expect(voidTransaction).toHaveBeenCalledWith(expect.any(Object), 'hashValue', {});
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
    (getAddressWalletInfo as jest.Mock).mockResolvedValue({});
    (generateAddresses as jest.Mock).mockResolvedValue({
      newAddresses: ['mockAddress1', 'mockAddress2'],
      lastUsedAddressIndex: 1
    });
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
            metadata: { voided_by: ['mockVoidedBy'], first_block: [] },
          },
        },
      },
    };

    (getTransactionById as jest.Mock).mockResolvedValue(null);

    const result = await metadataDiff({} as any, event as any);

    expect(result.type).toBe('IGNORE');
  });

  it('should handle new transactions', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: [] },
          },
        },
      },
    };

    (getTransactionById as jest.Mock).mockResolvedValue(null);

    const result = await metadataDiff({} as any, event as any);
    expect(result.type).toBe('TX_NEW');
  });

  it('should handle transaction voided but not voided in database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: ['mockVoidedBy'], first_block: [] },
          },
        },
      },
    };
    const mockDbTransaction = { voided: false };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.type).toBe('TX_VOIDED');
  });

  it('should ignore transaction voided and also voided in database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: ['mockVoidedBy'], first_block: [] },
          },
        },
      },
    };
    const mockDbTransaction = { voided: true };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.type).toBe('IGNORE');
  });

  it('should handle transaction with first_block but no height in database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: ['mockFirstBlock'] },
          },
        },
      },
    };
    const mockDbTransaction = { height: null };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.type).toBe('TX_FIRST_BLOCK');
  });

  it('should ignore transaction with first_block and height in database', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: ['mockFirstBlock'] },
          },
        },
      },
    };
    const mockDbTransaction = { height: 1 };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.type).toBe('IGNORE');
  });

  it('should return IGNORE for other scenarios', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: [] },
          },
        },
      },
    };
    const mockDbTransaction = { height: 1, voided: false };
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.type).toBe('IGNORE');
  });

  it('should handle errors and destroy the database connection', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: [] },
          },
        },
      },
    };
    (getTransactionById as jest.Mock).mockRejectedValue(new Error('Mock Error'));

    await expect(metadataDiff({} as any, event as any)).rejects.toThrow('Mock Error');
    expect(mockDb.destroy).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('e', new Error('Mock Error'));
  });

  it('should handle transaction transactions that are not voided anymore', async () => {
    const event = {
      event: {
        event: {
          data: {
            hash: 'mockHash',
            metadata: { voided_by: [], first_block: [] },
          },
        },
      },
    };
    const mockDbTransaction = { voided: true }; // Indicate that the transaction was voided in the database.
    (getTransactionById as jest.Mock).mockResolvedValue(mockDbTransaction);

    const result = await metadataDiff({} as any, event as any);
    expect(result.type).toBe('TX_UNVOIDED');
  });
});
