/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as Services from '../../src/services';
import { SyncMachine } from '../../src/machines';
import { interpret } from 'xstate';
import { getDbConnection, getTokenInformation, getTokensCreatedByTx } from '../../src/db';
import { Connection } from 'mysql2/promise';
import { cleanDatabase, transitionUntilEvent } from './utils';

import {
  DB_NAME,
  DB_USER,
  DB_PORT,
  DB_PASS,
  DB_ENDPOINT,
} from './config';

jest.mock('../../src/config', () => {
  return {
    __esModule: true,
    default: jest.fn(() => ({})),
  };
});

jest.mock('../../src/utils/aws', () => {
  return {
    sendRealtimeTx: jest.fn(),
    invokeOnTxPushNotificationRequestedLambda: jest.fn(),
  };
});

import getConfig from '../../src/config';

const TOKEN_CREATION_PORT = 8093;
const TOKEN_CREATION_LAST_EVENT = 46;

// @ts-expect-error
getConfig.mockReturnValue({
  NETWORK: 'testnet',
  SERVICE_NAME: 'daemon-test',
  CONSOLE_LEVEL: 'debug',
  TX_CACHE_SIZE: 100,
  BLOCK_REWARD_LOCK: 300,
  FULLNODE_PEER_ID: 'simulator_peer_id',
  STREAM_ID: 'simulator_stream_id',
  FULLNODE_NETWORK: 'unittests',
  FULLNODE_HOST: `127.0.0.1:${TOKEN_CREATION_PORT}`,
  USE_SSL: false,
  DB_ENDPOINT,
  DB_NAME,
  DB_USER,
  DB_PASS,
  DB_PORT,
  ACK_TIMEOUT_MS: 20000,
});

let mysql: Connection;

beforeAll(async () => {
  mysql = await getDbConnection();
  await cleanDatabase(mysql);
});

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  jest.resetAllMocks();
  if (mysql && 'release' in mysql) {
    // @ts-expect-error - pooled connection has release method
    await mysql.release();
  }
});

// Mock checkForMissedEvents since HTTP API is not available in test simulators
jest.spyOn(Services, 'checkForMissedEvents').mockImplementation(async () => ({
  hasNewEvents: false,
  events: [],
}));

describe('token creation scenario', () => {
  beforeAll(async () => {
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    await cleanDatabase(mysql);
  });

  it('should sync and verify two tokens were created', async () => {
    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, TOKEN_CREATION_LAST_EVENT);

    // Query all tokens from the database
    const [allTokens] = await mysql.query<any[]>('SELECT * FROM `token`');

    // We expect exactly 2 tokens to be created:
    // 1. RGT (via regular CREATE_TOKEN_TX)
    // 2. NC Token (via nano contract syscall)
    expect(allTokens.length).toBe(2);

    // Find tokens by name
    const rgtToken = allTokens.find(t => t.name === 'RGT');
    const ncToken = allTokens.find(t => t.name === 'NC Token');

    // Verify RGT token was created
    expect(rgtToken).toBeDefined();
    expect(rgtToken?.name).toBe('RGT');
    expect(rgtToken?.symbol).toBe('RGT');

    // Verify NC Token was created
    expect(ncToken).toBeDefined();
    expect(ncToken?.name).toBe('NC Token');
    expect(ncToken?.symbol).toBe('NCT');

    // Verify token creation mappings exist
    const [tokenCreationMappings] = await mysql.query<any[]>(
      'SELECT * FROM `token_creation` WHERE token_id IN (?, ?)',
      [rgtToken!.id, ncToken!.id]
    );
    expect(tokenCreationMappings.length).toBe(2);
  }, 30000);
});
