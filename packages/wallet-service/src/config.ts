/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

interface EnvironmentConfig {
  defaultServer: string;
  stage: string;
  network: string;
  serviceName: string;
  maxAddressGap: number;
  voidedTxOffset: number;
  blockRewardLock: number;
  confirmFirstAddress: boolean;
  wsDomain: string;
  dbEndpoint: string;
  dbName: string;
  dbUser: string;
  dbPass: string;
  redisHost: string;
  redisPort: number;
  authSecret: string;
  explorerServiceLambdaEndpoint: string;
  walletServiceLambdaEndpoint: string;
  pushNotification: boolean;
  pushAllowedProviders: string;
}

let ENVIRONMENT_CONFIG: EnvironmentConfig = null;

function loadEnvConfig() {
  ENVIRONMENT_CONFIG = {
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
    redisPort: Number.parseInt(process.env.REDIS_PORT,  10),
    authSecret: process.env.AUTH_SECRET,
    explorerServiceLambdaEndpoint: process.env.EXPLORER_SERVICE_LAMBDA_ENDPOINT,
    walletServiceLambdaEndpoint: process.env.WALLET_SERVICE_LAMBDA_ENDPOINT,
    pushNotification: process.env.PUSH_NOTIFICATION === 'true',
    pushAllowedProviders: process.env.PUSH_ALLOWED_PROVIDERS,
  };
}

const handler = {
  get(target, prop, receiver) {
    if (ENVIRONMENT_CONFIG === null) {
      loadEnvConfig();
    }
    return Reflect.get(target, prop, receiver);
  },
};

export default new Proxy<EnvironmentConfig>(ENVIRONMENT_CONFIG, handler);
