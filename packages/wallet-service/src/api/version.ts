/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { APIGatewayProxyHandler } from 'aws-lambda';
import 'source-map-support/register';

import {
  closeDbConnection,
  getDbConnection,
  getUnixTimestamp,
} from '@src/utils';
import { warmupMiddleware } from '@src/api/utils';
import { getFullnodeData } from '@src/nodeConfig'
import errorHandler from '@src/api/middlewares/errorHandler';
import middy from '@middy/core';
import cors from '@middy/http-cors';

const mysql = getDbConnection();

/**
 * What this wallet-service supports, returned beside the fullnode's data so
 * clients can feature-detect it. Service-owned: should the fullnode add a flag
 * of its own to `/version`, it needs a different key.
 *
 * A client must read a missing flag as unsupported: deployments from before it
 * existed don't send it.
 */
export const SERVICE_CAPABILITIES = {
  /**
   * Accepts shielded key registration on load and serves shielded balances
   * and history. Static: whether recovery works right now (the native crypto
   * provider is loaded) is the healthcheck's to report, and loading it here
   * would put a native load in a public, frequently warmed endpoint.
   */
  shieldedOutputsEnabled: true,
} as const;

/*
 * Get version data from the stored data from the connected fullnode, with
 * this service's capabilities
 *
 * This lambda is called by API Gateway on GET /version
 */
export const get: APIGatewayProxyHandler = middy(async () => {
  const versionData = await getFullnodeData(mysql);

  await closeDbConnection(mysql);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      data: {
        ...versionData,
        ...SERVICE_CAPABILITIES,
        timestamp: getUnixTimestamp(),
      },
    }),
  };
}).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());
