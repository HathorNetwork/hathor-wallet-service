/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import 'dotenv/config';

const requiredEnvs = [
  'FULLNODE_HOST',
];

export const checkEnvVariables = () => {
  const missingEnv = requiredEnvs.filter(envVar => process.env[envVar] === undefined);

  if (missingEnv.length > 0) {
    throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  }
};

// Fullnode connection
export const FULLNODE_HOST = process.env.FULLNODE_HOST!;
export const USE_SSL = process.env.USE_SSL === 'true';

// Download configuration
export const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '5000', 10);
export const PARALLEL_CONNECTIONS = parseInt(process.env.PARALLEL_CONNECTIONS ?? '5', 10);
export const WINDOW_SIZE = parseInt(process.env.WINDOW_SIZE ?? '100', 10);

// Database configuration
export const DB_PATH = process.env.DB_PATH ?? './events.sqlite';

export const getConfig = () => {
  checkEnvVariables();

  return {
    FULLNODE_HOST,
    USE_SSL,
    BATCH_SIZE,
    PARALLEL_CONNECTIONS,
    WINDOW_SIZE,
    DB_PATH,
  };
};

export default getConfig;
