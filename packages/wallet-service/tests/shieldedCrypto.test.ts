/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';

// The modules under test reach the provider through `@src/shieldedCrypto`,
// which every other test maps to a stub. Here they get the real one.
jest.mock('@src/shieldedCrypto', () => jest.requireActual('../src/shieldedCrypto'));
import {
  clearShieldedCryptoProvider,
  isShieldedCryptoProviderRegistered,
} from '@wallet-service/common';
// By path: `@src/shieldedCrypto` maps to a stub in tests (see jest.config.js).
import {
  ensureShieldedCryptoProvider,
  loadNodeShieldedCryptoProvider,
  resetShieldedCryptoProviderAttempt,
  shieldedCryptoLoadError,
} from '../src/shieldedCrypto';
import { findAndRewindShielded } from '@src/shieldedRecovery';
import { checkShieldedCryptoProvider } from '@src/api/healthcheck';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase } from '@tests/utils';

const logger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} } as unknown as Logger;

beforeEach(() => {
  clearShieldedCryptoProvider();
  resetShieldedCryptoProviderAttempt();
});

const mysql: ServerlessMysql = getDbConnection();

afterAll(async () => {
  clearShieldedCryptoProvider();
  await closeDbConnection(mysql);
});

describe('ensureShieldedCryptoProvider', () => {
  it('registers the native provider on this platform', async () => {
    await ensureShieldedCryptoProvider(logger);

    expect(isShieldedCryptoProviderRegistered()).toBe(true);
    expect(shieldedCryptoLoadError()).toBeNull();
  });

  it('records why the binding failed to load, and tries only once per process', async () => {
    const load = jest.fn(() => {
      throw new Error('Cannot find module ./ct-crypto.linux-x64-gnu.node');
    });

    await ensureShieldedCryptoProvider(logger, load);
    await ensureShieldedCryptoProvider(logger, load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(isShieldedCryptoProviderRegistered()).toBe(false);
    expect(shieldedCryptoLoadError()).toContain('Cannot find module');
  });

  it('does nothing when a provider is already registered', async () => {
    await ensureShieldedCryptoProvider(logger);
    const load = jest.fn(loadNodeShieldedCryptoProvider);
    resetShieldedCryptoProviderAttempt();

    await ensureShieldedCryptoProvider(logger, load);

    expect(load).not.toHaveBeenCalled();
  });
});

describe('what turns shielded recovery on', () => {
  it('a sweep registers the native provider itself, and runs', async () => {
    await cleanDatabase(mysql);

    const outcome = await findAndRewindShielded(mysql, 'w1', logger);

    // `skipped: true` is what a sweep reports when no provider got registered.
    expect(outcome.skipped).toBe(false);
    expect(isShieldedCryptoProviderRegistered()).toBe(true);
  });

  it('the healthcheck registers the native provider itself, and passes', async () => {
    const response = await checkShieldedCryptoProvider();

    expect(response).toMatchObject({ status: 'pass' });
    expect(isShieldedCryptoProviderRegistered()).toBe(true);
  });
});
