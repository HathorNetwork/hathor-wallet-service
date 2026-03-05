import BalanceValidationActor from '../../src/actors/BalanceValidationActor';
import logger from '../../src/logger';
import { EventTypes } from '../../src/types/event';
import getConfig from '../../src/config';
import * as db from '../../src/db';
import { addAlert, Severity } from '@wallet-service/common';

jest.useFakeTimers();
jest.spyOn(global, 'setInterval');
jest.spyOn(global, 'clearInterval');

jest.mock('../../src/db', () => ({
  getDbConnection: jest.fn(),
  fetchAddressBalance: jest.fn(),
  fetchAddressTxHistorySum: jest.fn(),
  fetchAllDistinctAddresses: jest.fn(),
}));

jest.mock('@wallet-service/common', () => {
  const actual = jest.requireActual('@wallet-service/common');
  return {
    ...actual,
    addAlert: jest.fn().mockResolvedValue(undefined),
  };
});

// Helper to flush all pending microtasks/promises
const flushPromises = () => new Promise(jest.requireActual('timers').setImmediate);

describe('BalanceValidationActor', () => {
  let mockMysql: any;

  let stopFns: Array<() => void> = [];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    mockMysql = {
      release: jest.fn(),
    };
    (db.getDbConnection as jest.Mock).mockResolvedValue(mockMysql);
    stopFns = [];
  });

  afterEach(() => {
    stopFns.forEach(fn => fn());
    stopFns = [];
  });

  afterAll(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('should not start when BALANCE_VALIDATION_ENABLED is false', () => {
    const config = getConfig();
    config['BALANCE_VALIDATION_ENABLED'] = false;

    const mockCallback = jest.fn();
    const mockReceive = jest.fn();

    stopFns.push(BalanceValidationActor(mockCallback, mockReceive, config));

    expect(mockReceive).not.toHaveBeenCalled();
  });

  it('should start and stop validation timer on START/STOP events', () => {
    const config = getConfig();
    config['BALANCE_VALIDATION_ENABLED'] = true;
    config['BALANCE_VALIDATION_INTERVAL_MS'] = 60000;

    const mockCallback = jest.fn();
    let receiveCallback: any;
    const mockReceive = jest.fn().mockImplementation((cb) => {
      receiveCallback = cb;
    });

    stopFns.push(BalanceValidationActor(mockCallback, mockReceive, config));

    receiveCallback({
      type: EventTypes.BALANCE_VALIDATION_EVENT,
      event: { type: 'START' },
    });

    expect(setInterval).toHaveBeenCalledTimes(1);

    receiveCallback({
      type: EventTypes.BALANCE_VALIDATION_EVENT,
      event: { type: 'STOP' },
    });

    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it('should clear timer when actor is stopped', () => {
    const config = getConfig();
    config['BALANCE_VALIDATION_ENABLED'] = true;
    config['BALANCE_VALIDATION_INTERVAL_MS'] = 60000;

    const mockCallback = jest.fn();
    let receiveCallback: any;
    const mockReceive = jest.fn().mockImplementation((cb) => {
      receiveCallback = cb;
    });

    const stopActor = BalanceValidationActor(mockCallback, mockReceive, config);
    stopFns.push(stopActor);

    receiveCallback({
      type: EventTypes.BALANCE_VALIDATION_EVENT,
      event: { type: 'START' },
    });

    expect(setInterval).toHaveBeenCalledTimes(1);

    stopActor();

    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it('should detect mismatches and call addAlert', async () => {
    const config = getConfig();
    config['BALANCE_VALIDATION_ENABLED'] = true;
    config['BALANCE_VALIDATION_INTERVAL_MS'] = 5000;
    config['BALANCE_VALIDATION_BATCH_SIZE'] = 100;

    const mockCallback = jest.fn();
    let receiveCallback: any;
    const mockReceive = jest.fn().mockImplementation((cb) => {
      receiveCallback = cb;
    });

    (db.fetchAllDistinctAddresses as jest.Mock)
      .mockResolvedValueOnce(['addr1'])
      .mockResolvedValueOnce([]);

    (db.fetchAddressBalance as jest.Mock).mockResolvedValue([{
      address: 'addr1',
      tokenId: 'token1',
      unlockedBalance: BigInt(100),
      lockedBalance: BigInt(0),
      lockedAuthorities: 0,
      unlockedAuthorities: 0,
      timelockExpires: 0,
      transactions: 1,
    }]);

    (db.fetchAddressTxHistorySum as jest.Mock).mockResolvedValue([{
      address: 'addr1',
      tokenId: 'token1',
      balance: BigInt(200), // mismatch
      transactions: 1,
    }]);

    stopFns.push(BalanceValidationActor(mockCallback, mockReceive, config));

    receiveCallback({
      type: EventTypes.BALANCE_VALIDATION_EVENT,
      event: { type: 'START' },
    });

    // Run the interval callback
    jest.advanceTimersByTime(5000);

    // Flush all async operations
    await flushPromises();

    expect(db.fetchAllDistinctAddresses).toHaveBeenCalled();
    expect(db.fetchAddressBalance).toHaveBeenCalledWith(mockMysql, ['addr1']);
    expect(db.fetchAddressTxHistorySum).toHaveBeenCalledWith(mockMysql, ['addr1']);
    expect(addAlert).toHaveBeenCalledWith(
      'Balance validation found mismatches',
      expect.stringContaining('1 balance mismatch'),
      Severity.MAJOR,
      expect.objectContaining({ totalMismatches: 1 }),
      expect.anything(),
    );
    expect(mockMysql.release).toHaveBeenCalled();
  });

  it('should log info when no mismatches found', async () => {
    const config = getConfig();
    config['BALANCE_VALIDATION_ENABLED'] = true;
    config['BALANCE_VALIDATION_INTERVAL_MS'] = 5000;
    config['BALANCE_VALIDATION_BATCH_SIZE'] = 100;

    const mockCallback = jest.fn();
    let receiveCallback: any;
    const mockReceive = jest.fn().mockImplementation((cb) => {
      receiveCallback = cb;
    });

    const mockLoggerInfo = jest.spyOn(logger, 'info');

    (db.fetchAllDistinctAddresses as jest.Mock)
      .mockResolvedValueOnce(['addr1'])
      .mockResolvedValueOnce([]);

    (db.fetchAddressBalance as jest.Mock).mockResolvedValue([{
      address: 'addr1',
      tokenId: 'token1',
      unlockedBalance: BigInt(100),
      lockedBalance: BigInt(0),
      lockedAuthorities: 0,
      unlockedAuthorities: 0,
      timelockExpires: 0,
      transactions: 1,
    }]);

    (db.fetchAddressTxHistorySum as jest.Mock).mockResolvedValue([{
      address: 'addr1',
      tokenId: 'token1',
      balance: BigInt(100), // matches
      transactions: 1,
    }]);

    stopFns.push(BalanceValidationActor(mockCallback, mockReceive, config));

    receiveCallback({
      type: EventTypes.BALANCE_VALIDATION_EVENT,
      event: { type: 'START' },
    });

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(addAlert).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('Balance validation complete, no mismatches found'),
    );
  });

  it('should handle DB errors without crashing', async () => {
    const config = getConfig();
    config['BALANCE_VALIDATION_ENABLED'] = true;
    config['BALANCE_VALIDATION_INTERVAL_MS'] = 5000;
    config['BALANCE_VALIDATION_BATCH_SIZE'] = 100;

    const mockCallback = jest.fn();
    let receiveCallback: any;
    const mockReceive = jest.fn().mockImplementation((cb) => {
      receiveCallback = cb;
    });

    const mockLoggerError = jest.spyOn(logger, 'error');

    (db.getDbConnection as jest.Mock).mockRejectedValue(new Error('DB connection failed'));

    stopFns.push(BalanceValidationActor(mockCallback, mockReceive, config));

    receiveCallback({
      type: EventTypes.BALANCE_VALIDATION_EVENT,
      event: { type: 'START' },
    });

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('Balance validation error'),
    );
  });

  it('should process multiple batches', async () => {
    const config = getConfig();
    config['BALANCE_VALIDATION_ENABLED'] = true;
    config['BALANCE_VALIDATION_INTERVAL_MS'] = 5000;
    config['BALANCE_VALIDATION_BATCH_SIZE'] = 2;

    const mockCallback = jest.fn();
    let receiveCallback: any;
    const mockReceive = jest.fn().mockImplementation((cb) => {
      receiveCallback = cb;
    });

    (db.fetchAllDistinctAddresses as jest.Mock)
      .mockResolvedValueOnce(['addr1', 'addr2'])
      .mockResolvedValueOnce(['addr3'])
      .mockResolvedValueOnce([]);

    (db.fetchAddressBalance as jest.Mock).mockResolvedValue([]);
    (db.fetchAddressTxHistorySum as jest.Mock).mockResolvedValue([]);

    stopFns.push(BalanceValidationActor(mockCallback, mockReceive, config));

    receiveCallback({
      type: EventTypes.BALANCE_VALIDATION_EVENT,
      event: { type: 'START' },
    });

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(db.fetchAllDistinctAddresses).toHaveBeenCalledWith(mockMysql, 2, 0);
    expect(db.fetchAllDistinctAddresses).toHaveBeenCalledWith(mockMysql, 2, 2);
    expect(db.fetchAllDistinctAddresses).toHaveBeenCalledWith(mockMysql, 2, 3);
    expect(db.fetchAddressBalance).toHaveBeenCalledTimes(2);
    expect(db.fetchAddressTxHistorySum).toHaveBeenCalledTimes(2);
  });
});
