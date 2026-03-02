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
  const missingEnv = requiredEnvs.filter((envVar) => {
    const value = process.env[envVar];
    return value === undefined || value.trim() === '';
  });

  if (missingEnv.length > 0) {
    throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  }
};

const parsePositiveInt = (envName: string, fallback: number): number => {
  const raw = process.env[envName];
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${envName}: expected a positive integer, got "${raw}"`);
  }
  return value;
};

// Fullnode connection
export const FULLNODE_HOST = process.env.FULLNODE_HOST!;
export const USE_SSL = process.env.USE_SSL === 'true';

// Download configuration
export const BATCH_SIZE = parsePositiveInt('BATCH_SIZE', 5000);
export const PARALLEL_CONNECTIONS = parsePositiveInt('PARALLEL_CONNECTIONS', 5);
export const WINDOW_SIZE = parsePositiveInt('WINDOW_SIZE', 100);
export const CONNECTION_TIMEOUT_MS = parsePositiveInt('CONNECTION_TIMEOUT_MS', 60000);

// Database configuration
export const DB_PATH = process.env.DB_PATH ?? './events.sqlite';

