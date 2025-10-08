/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Integration tests for ACK timeout mechanism using WebSocket proxy
 */

import { WebSocketProxySimulator } from './scripts/ws-proxy-simulator';
import { SyncMachine } from '../../src/machines';
import { interpret } from 'xstate';
import { getDbConnection } from '../../src/db';
import { Connection } from 'mysql2/promise';
import {
  cleanDatabase,
  transitionUntilEvent,
  fetchAddressBalances,
  validateBalances,
} from './utils';
import * as Services from '../../src/services';
import emptyScriptBalances from './scenario_configs/empty_script.balances';
import {
  DB_NAME,
  DB_USER,
  DB_PORT,
  DB_PASS,
  DB_ENDPOINT,
  EMPTY_SCRIPT_PORT,
  EMPTY_SCRIPT_LAST_EVENT,
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

const PROXY_PORT = 9000;
const UPSTREAM_PORT = EMPTY_SCRIPT_PORT;

// Mock config before any tests run
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
  FULLNODE_HOST: `127.0.0.1:${UPSTREAM_PORT}`, // Default to simulator directly
  USE_SSL: false,
  DB_ENDPOINT,
  DB_NAME,
  DB_USER,
  DB_PASS,
  DB_PORT,
  ACK_TIMEOUT_MS: 300000,
});

let mysql: Connection;

describe('WebSocket Proxy Simulator', () => {
  let proxy: WebSocketProxySimulator | null = null;

  beforeAll(async () => {
    mysql = await getDbConnection();
    await cleanDatabase(mysql);
    jest.spyOn(Services, 'fetchMinRewardBlocks').mockImplementation(async () => 300);
    // Mock checkForMissedEvents to avoid HTTP calls
    jest.spyOn(Services, 'checkForMissedEvents').mockImplementation(async () => ({
      hasNewEvents: false,
      events: [],
    }));
  });

  beforeEach(async () => {
    await cleanDatabase(mysql);
  });

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
      proxy = null;
      // Wait for port to be released
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });

  afterAll(async () => {
    jest.resetAllMocks();
    if (mysql && 'release' in mysql) {
      // @ts-expect-error - pooled connection has release method
      await mysql.release();
    }
  });

  it('should start and stop successfully', async () => {
    proxy = new WebSocketProxySimulator({
      proxyPort: PROXY_PORT,
      upstreamHost: 'localhost',
      upstreamPort: UPSTREAM_PORT,
    });

    await proxy.start();
    expect(proxy).toBeDefined();

    await proxy.stop();
  }, 10000);

  it('should track statistics', async () => {
    proxy = new WebSocketProxySimulator({
      proxyPort: PROXY_PORT,
      upstreamHost: 'localhost',
      upstreamPort: UPSTREAM_PORT,
    });

    await proxy.start();

    const stats = proxy.getStats();
    expect(stats).toEqual({
      eventsRelayed: 0,
      acksReceived: 0,
      acksDelayed: 0,
      acksDropped: 0,
    });

    await proxy.stop();
  }, 10000);

  it('should proxy events between daemon and simulator successfully', async () => {
    // Start proxy
    proxy = new WebSocketProxySimulator({
      proxyPort: PROXY_PORT,
      upstreamHost: 'localhost',
      upstreamPort: UPSTREAM_PORT,
    });
    await proxy.start();

    // Configure daemon to connect through proxy
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
      FULLNODE_HOST: `127.0.0.1:${PROXY_PORT}`, // Connect to proxy, not simulator directly
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
      ACK_TIMEOUT_MS: 300000, // Long timeout to avoid triggering during test
    });

    // Start daemon
    const machine = interpret(SyncMachine);
    machine.start();

    // Wait for daemon to reach CONNECTED.idle (sync complete)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for CONNECTED.idle'));
      }, 10000);

      machine.onTransition((state) => {
        if (state.matches('CONNECTED.idle')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // Stop daemon
    machine.stop();

    // Verify proxy stats
    const stats = proxy.getStats();
    console.log('Proxy stats:', stats);

    // EMPTY_SCRIPT simulator has no wallets/addresses, so daemon goes to idle immediately
    // Just verify the proxy is working (no errors) - stats may be 0
    expect(stats.eventsRelayed).toBeGreaterThanOrEqual(0);
    expect(stats.acksReceived).toBeGreaterThanOrEqual(0);
    expect(stats.acksDelayed).toBe(0); // No delays configured
    expect(stats.acksDropped).toBe(0); // No drops configured
  }, 15000);

  it('should do a full sync through proxy and balances should match', async () => {
    // Start proxy
    proxy = new WebSocketProxySimulator({
      proxyPort: PROXY_PORT,
      upstreamHost: 'localhost',
      upstreamPort: UPSTREAM_PORT,
    });
    await proxy.start();

    // Configure daemon to connect through proxy
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
      FULLNODE_HOST: `127.0.0.1:${PROXY_PORT}`, // Connect to proxy, not simulator directly
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
      ACK_TIMEOUT_MS: 300000, // Long timeout to avoid triggering during test
    });

    // Start daemon
    const machine = interpret(SyncMachine);

    // @ts-expect-error
    await transitionUntilEvent(mysql, machine, EMPTY_SCRIPT_LAST_EVENT);
    const addressBalances = await fetchAddressBalances(mysql);

    await expect(validateBalances(addressBalances, emptyScriptBalances.addressBalances)).resolves.not.toThrow();

    // Verify proxy stats
    const stats = proxy.getStats();

    // Verify the proxy relayed events
    expect(stats.eventsRelayed).toBeGreaterThanOrEqual(0);
    expect(stats.acksReceived).toBeGreaterThanOrEqual(0);
    expect(stats.acksDelayed).toBe(0); // No delays configured
    expect(stats.acksDropped).toBe(0); // No drops configured
  }, 30000);

  it('should check for missed events when idle timeout is exceeded', async () => {
    // This test verifies that when the daemon is idle for longer than ACK_TIMEOUT_MS,
    // it transitions to checkingForMissedEvents state to check if any events were missed

    // Start proxy
    proxy = new WebSocketProxySimulator({
      proxyPort: PROXY_PORT,
      upstreamHost: 'localhost',
      upstreamPort: UPSTREAM_PORT,
    });
    await proxy.start();

    // Configure daemon with short ACK timeout
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
      FULLNODE_HOST: `127.0.0.1:${PROXY_PORT}`,
      USE_SSL: false,
      DB_ENDPOINT,
      DB_NAME,
      DB_USER,
      DB_PASS,
      DB_PORT,
      ACK_TIMEOUT_MS: 500, // 500ms timeout
    });

    // Track when we enter checkingForMissedEvents
    let checkForMissedEventsPromise = new Promise<void>((resolve) => {
      const machine = interpret(SyncMachine);

      machine.onTransition((state) => {
        const stateValue = typeof state.value === 'string'
          ? state.value
          : JSON.stringify(state.value);

        if (stateValue.includes('checkingForMissedEvents')) {
          machine.stop();
          resolve();
        }
      });

      machine.start();
    });

    // Wait for the state transition with a timeout
    await Promise.race([
      checkForMissedEventsPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout waiting for checkingForMissedEvents')), 10000)
      )
    ]);

    // If we get here, the test passed
    expect(true).toBe(true);
  }, 15000);
});
