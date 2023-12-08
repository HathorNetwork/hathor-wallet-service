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

// Fullnode information, used to make sure we're connected to the same fullnode
export const FULLNODE_PEER_ID = process.env.FULLNODE_PEER_ID;
export const FULLNODE_HOST = process.env.FULLNODE_HOST;
export const STREAM_ID = process.env.STREAM_ID;
export const NETWORK = process.env.NETWORK;
export const WS_URL = process.env.WS_URL;

// Database info
export const DB_ENDPOINT = process.env.DB_ENDPOINT;
export const DB_NAME = process.env.DB_NAME;
export const DB_USER = process.env.DB_USER;
export const DB_PASS = process.env.DB_PASS;
export const DB_PORT = parseInt(process.env.DB_PORT ?? '3306', 10);

// Other
export const USE_SSL = process.env.USE_SSL;


export default () => ({
  SERVICE_NAME,
  CONSOLE_LEVEL,
  TX_CACHE_SIZE,
  BLOCK_REWARD_LOCK,
  FULLNODE_PEER_ID,
  FULLNODE_HOST,
  USE_SSL,
  STREAM_ID,
  NETWORK,
  WS_URL,
  DB_ENDPOINT,
  DB_NAME,
  DB_USER,
  DB_PASS,
  DB_PORT,
});
