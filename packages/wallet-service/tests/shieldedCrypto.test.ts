/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
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

const logger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} } as unknown as Logger;

beforeEach(() => {
  clearShieldedCryptoProvider();
  resetShieldedCryptoProviderAttempt();
});

afterAll(() => clearShieldedCryptoProvider());

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
