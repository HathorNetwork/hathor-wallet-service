/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Joi from 'joi';
import { EnvironmentConfig } from '@src/types';
import { EnvironmentConfigSchema } from '@src/schemas';

export function loadEnvConfig(): EnvironmentConfig {
  const config = {
    defaultServer: process.env.DEFAULT_SERVER ?? 'https://node1.mainnet.hathor.network/v1a/',
    stage: process.env.STAGE,
    network: process.env.NETWORK,
    serviceName: process.env.SERVICE_NAME,
    maxAddressGap: Number.parseInt(process.env.MAX_ADDRESS_GAP, 10),
    voidedTxOffset: Number.parseInt(process.env.VOIDED_TX_OFFSET, 10),
    blockRewardLock: Number.parseInt(process.env.BLOCK_REWARD_LOCK, 10),
    confirmFirstAddress: process.env.CONFIRM_FIRST_ADDRESS === 'true',
    wsDomain: process.env.WS_DOMAIN,
    dbEndpoint: process.env.DB_ENDPOINT,
    dbName: process.env.DB_NAME,
    dbUser: process.env.DB_USER,
    dbPass: process.env.DB_PASS,
    redisHost: process.env.REDIS_HOST,
    redisPort: Number.parseInt(process.env.REDIS_PORT, 10),
    authSecret: process.env.AUTH_SECRET,
    explorerServiceLambdaEndpoint: process.env.EXPLORER_SERVICE_LAMBDA_ENDPOINT,
    walletServiceLambdaEndpoint: process.env.WALLET_SERVICE_LAMBDA_ENDPOINT,
    pushNotification: process.env.PUSH_NOTIFICATION === 'true',
    pushAllowedProviders: process.env.PUSH_ALLOWED_PROVIDERS,
  };

  const { value, error } = EnvironmentConfigSchema.validate(config);
  if (error) {
    throw error;
  }

  return value;
};

/**
 * Get a lazy loaded config.
 */
function getConfig(): EnvironmentConfig {
  let loaded = false;
  // @ts-ignore
  let config: EnvironmentConfig = {};
  const handler = {
    get(target, prop, receiver) {
      if (!loaded) {
        config = loadEnvConfig();
        loaded = true;
      }
      config[prop];
    },
  };

  return new Proxy<EnvironmentConfig>(config, handler);
}

export default getConfig();
