/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { EnvironmentConfig } from '@src/types';
import { EnvironmentConfigSchema } from '@src/schemas';
import { Severity, addAlert } from '@wallet-service/common';

export function loadEnvConfig(): EnvironmentConfig {
  const config: EnvironmentConfig = {
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
    dbPort: Number.parseInt(process.env.DB_PORT, 10),
    dbPass: process.env.DB_PASS,
    redisUrl: process.env.REDIS_URL,
    redisPassword: process.env.REDIS_PASSWORD,
    authSecret: process.env.AUTH_SECRET,
    walletServiceLambdaEndpoint: process.env.WALLET_SERVICE_LAMBDA_ENDPOINT,
    pushNotificationEnabled: process.env.PUSH_NOTIFICATION_ENABLED === 'true',
    pushAllowedProviders: process.env.PUSH_ALLOWED_PROVIDERS,
    isOffline: process.env.IS_OFFLINE === 'true',
    txHistoryMaxCount: Number.parseInt(process.env.TX_HISTORY_MAX_COUNT || '50', 10),
    healthCheckMaximumHeightDifference: Number.parseInt(process.env.HEALTHCHECK_MAXIMUM_HEIGHT_DIFFERENCE ?? '5', 10),

    awsRegion: process.env.AWS_REGION,

    firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
    firebasePrivateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
    firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    firebaseClientId: process.env.FIREBASE_CLIENT_ID,
    firebaseAuthUri: process.env.FIREBASE_AUTH_URI,
    firebaseTokenUri: process.env.FIREBASE_TOKEN_URI,
    firebaseAuthProviderX509CertUrl: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    firebaseClientX509CertUrl: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY,

    maxLoadWalletRetries: Number.parseInt(process.env.MAX_LOAD_WALLET_RETRIES || '5', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    createNftMaxRetries: Number.parseInt(process.env.CREATE_NFT_MAX_RETRIES || '3', 10),
    warnMaxReorgSize: Number.parseInt(process.env.WARN_MAX_REORG_SIZE || '100', 10),
  };

  if (process.env.NODE_ENV === 'test') {
    return config;
  }

  const { value, error } = EnvironmentConfigSchema.validate(config);
  if (error) {
    addAlert(
      'Environment config ',
      error.message,
      Severity.CRITICAL,
      null,
      // @ts-ignore: cannot import logger on this file, creates an import cycle
      { error: console.error },
    );
    throw error;
  }

  return value;
};

export default loadEnvConfig();
