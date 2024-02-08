/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const requiredEnvs = [
  'DB_ENDPOINT',
  'DB_NAME',
  'DB_USER',
  'DB_PORT',
  'DB_PASS',
  'FULLNODE_PEER_ID',
  'FULLNODE_HOST',
  'USE_SSL',
  'STREAM_ID',
  'NETWORK',
  'NEW_TX_SQS',
  'PUSH_NOTIFICATION_ENABLED',
  'WALLET_SERVICE_LAMBDA_ENDPOINT',
  'STAGE',
  'ACCOUNT_ID',
  'ALERT_MANAGER_TOPIC',
  'ALERT_MANAGER_REGION',
];


export const checkEnvVariables = () => {
  const missingEnv = requiredEnvs.filter(envVar => process.env[envVar] === undefined);

  if (missingEnv.length > 0) {
    throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  }
};

// The service name to go with the logs
export const SERVICE_NAME = process.env.SERVICE_NAME ?? 'wallet-service-daemon';
// The default log level
export const CONSOLE_LEVEL = process.env.CONSOLE_LEVEL ?? 'debug';
// Number of transactions to cache in the LRU in-memory cache
export const TX_CACHE_SIZE = parseInt(process.env.TX_CACHE_SIZE ?? '10000', 10);
// Number of blocks before unlocking a block utxo
export const BLOCK_REWARD_LOCK = parseInt(process.env.BLOCK_REWARD_LOCK ?? '10', 10);
export const STAGE = process.env.STAGE;

// Fullnode information, used to make sure we're connected to the same fullnode
export const FULLNODE_PEER_ID = process.env.FULLNODE_PEER_ID;
export const FULLNODE_HOST = process.env.FULLNODE_HOST;
export const STREAM_ID = process.env.STREAM_ID;
export const NETWORK = process.env.NETWORK;

// Database info
export const DB_ENDPOINT = process.env.DB_ENDPOINT;
export const DB_NAME = process.env.DB_NAME;
export const DB_USER = process.env.DB_USER;
export const DB_PASS = process.env.DB_PASS;
export const DB_PORT = parseInt(process.env.DB_PORT ?? '3306', 10);

// Lambdas info
export const NEW_TX_SQS = process.env.NEW_TX_SQS;
export const PUSH_NOTIFICATION_ENABLED = process.env.PUSH_NOTIFICATION_ENABLED === 'true';
export const WALLET_SERVICE_LAMBDA_ENDPOINT = process.env.WALLET_SERVICE_LAMBDA_ENDPOINT;
export const ON_TX_PUSH_NOTIFICATION_REQUESTED_FUNCTION_NAME = process.env.ON_TX_PUSH_NOTIFICATION_REQUESTED_FUNCTION_NAME;
export const PUSH_NOTIFICATION_LAMBDA_REGION = process.env.PUSH_NOTIFICATION_LAMBDA_REGION;

// AWS information
export const ACCOUNT_ID = process.env.ACCOUNT_ID;
export const ALERT_MANAGER_REGION = process.env.ALERT_MANAGER_REGION;
export const ALERT_MANAGER_TOPIC  = process.env.ALERT_MANAGER_TOPIC;

// Healthcheck configuration
export const HEALTHCHECK_ENABLED = process.env.HEALTHCHECK_ENABLED === 'true';
export const HEALTHCHECK_SERVER_URL = process.env.HEALTHCHECK_SERVER_URL;
export const HEALTHCHECK_SERVER_API_KEY = process.env.HEALTHCHECK_SERVER_API_KEY;
export const HEALTHCHECK_PING_INTERVAL = parseInt(process.env.HEALTHCHECK_PING_INTERVAL ?? '10000', 10);  // 10 seconds

// Other
export const USE_SSL = process.env.USE_SSL;

export default () => ({
  SERVICE_NAME,
  CONSOLE_LEVEL,
  TX_CACHE_SIZE,
  FULLNODE_PEER_ID,
  FULLNODE_HOST,
  USE_SSL,
  STREAM_ID,
  NETWORK,
  DB_ENDPOINT,
  DB_NAME,
  DB_USER,
  DB_PASS,
  DB_PORT,
  NEW_TX_SQS,
  PUSH_NOTIFICATION_ENABLED,
  WALLET_SERVICE_LAMBDA_ENDPOINT,
  STAGE,
  ACCOUNT_ID,
  ALERT_MANAGER_REGION,
  ALERT_MANAGER_TOPIC,
  ON_TX_PUSH_NOTIFICATION_REQUESTED_FUNCTION_NAME,
  PUSH_NOTIFICATION_LAMBDA_REGION,
  HEALTHCHECK_ENABLED,
  HEALTHCHECK_SERVER_URL,
  HEALTHCHECK_SERVER_API_KEY,
  HEALTHCHECK_PING_INTERVAL,
});
