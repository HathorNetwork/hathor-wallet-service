/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
import {
  IShieldedCryptoProvider,
  initShieldedCryptoProvider,
  isShieldedCryptoProviderRegistered,
} from '@wallet-service/common';

/**
 * Build the native shielded crypto provider.
 *
 * A literal `require`, so webpack still sees the dependency and the Lambda
 * artifact ships it, but not an `import`: the binding loads its native binary
 * when first required, and a missing or wrong-platform binary must disable
 * shielded recovery, not fail every handler that imports this module.
 */
export const loadNodeShieldedCryptoProvider = (): IShieldedCryptoProvider => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate, see above
  const binding: typeof import('@hathor/ct-crypto-node/provider') = require('@hathor/ct-crypto-node/provider');
  return binding.createDefaultShieldedCryptoProvider();
};

let attempt: Promise<void> | null = null;
let loadError: string | null = null;

/**
 * Register the native provider the first time this process needs it.
 *
 * Attempted once per process: a binary that failed to load fails the same way
 * on every retry, and the caller reports the absence through its own alert.
 */
export const ensureShieldedCryptoProvider = (
  logger: Logger,
  load: () => IShieldedCryptoProvider = loadNodeShieldedCryptoProvider,
): Promise<void> => {
  if (isShieldedCryptoProviderRegistered()) return Promise.resolve();
  if (!attempt) {
    attempt = initShieldedCryptoProvider(load).then((result) => {
      if (result.ok === false) {
        loadError = result.error;
        logger.error('Shielded crypto provider failed to load', { error: result.error });
        return;
      }
      logger.info('Shielded crypto provider registered');
    });
  }
  return attempt;
};

/** Why the last registration attempt failed, or null if none has. */
export const shieldedCryptoLoadError = (): string | null => loadError;

/** Forget the registration attempt — for test isolation. */
export const resetShieldedCryptoProviderAttempt = (): void => {
  attempt = null;
  loadError = null;
};
