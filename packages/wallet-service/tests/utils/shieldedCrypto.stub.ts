/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Stand-in for `@src/shieldedCrypto` in every test (see jest.config.js), so a
 * test controls the provider itself — through `ct-crypto-mock` or by clearing
 * it — and never picks up the native one by accident. `shieldedCrypto.test.ts`
 * imports the real module by path.
 */
export const loadNodeShieldedCryptoProvider = (): never => {
  throw new Error('the native shielded crypto provider is not loaded in tests');
};
export const ensureShieldedCryptoProvider = async (): Promise<void> => {};
export const shieldedCryptoLoadError = (): string | null => null;
export const resetShieldedCryptoProviderAttempt = (): void => {};
