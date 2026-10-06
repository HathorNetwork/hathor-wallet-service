/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  IShieldedCryptoProvider,
  initShieldedCryptoProvider,
  addAlert,
  Severity,
} from '@wallet-service/common';
import logger from './logger';

/**
 * Build the native shielded crypto provider.
 *
 * A literal `require` rather than an `import`: the binding loads its native
 * binary when first required, and a missing or wrong-platform binary must
 * degrade shielded recovery, not stop the daemon from starting.
 */
export const loadNodeShieldedCryptoProvider = (): IShieldedCryptoProvider => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate, see above
  const binding: typeof import('@hathor/ct-crypto-node/provider') = require('@hathor/ct-crypto-node/provider');
  return binding.createDefaultShieldedCryptoProvider();
};

/**
 * Register the shielded crypto provider before sync starts.
 *
 * A failure is reported once, loudly, and sync starts anyway: transparent
 * ingestion does not depend on it, and shielded outputs are still stored —
 * `unowned`, for a later recovery to pick up.
 */
export const registerShieldedCryptoProvider = async (
  load: () => IShieldedCryptoProvider = loadNodeShieldedCryptoProvider,
): Promise<boolean> => {
  const result = await initShieldedCryptoProvider(load);
  if (result.ok) {
    logger.info('Shielded crypto provider registered');
    return true;
  }
  logger.error('Shielded crypto provider failed to load; shielded outputs will not be recovered', {
    error: result.error,
  });
  try {
    await addAlert(
      'Shielded crypto provider failed to load',
      'The daemon started without a shielded crypto provider, so it stores shielded outputs '
      + 'but recovers none of them. Check the @hathor/ct-crypto-node binary for this platform.',
      Severity.MAJOR,
      { error: result.error, platform: `${process.platform}-${process.arch}`, source: 'daemon' },
      logger,
    );
  } catch (e) {
    logger.error('Failed to report the missing shielded crypto provider', { error: String(e) });
  }
  return false;
};
