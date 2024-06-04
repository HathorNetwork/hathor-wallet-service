/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

 export * as alertUtils from './alerting.utils';
 export * as nftUtils from './nft.utils';
 export * as walletUtils from './wallet.utils';

/**
 * Validates if a list of env variables are set in the environment. Throw if at least
 * one of them is missing
 *
 * @param envVariables - A list of variables to check
 */
export const assertEnvVariablesExistence = (envVariables: string[]): void => {
  const missingList = [];
  for (const envVariable of envVariables) {
    if (!(envVariable in process.env) || process.env[envVariable]?.length === 0) {
      missingList.push(envVariable);
    }
  }

  if (missingList.length > 0) {
    throw new Error(`Env missing the following variables ${missingList.join(', ')}`);
  }
};
