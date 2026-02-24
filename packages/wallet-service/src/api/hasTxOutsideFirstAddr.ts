/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import 'source-map-support/register';

import { ApiError } from '@src/api/errors';
import { closeDbAndGetError, warmupMiddleware } from '@src/api/utils';
import {
  getWallet,
  hasTransactionsOnNonFirstAddress,
} from '@src/db';
import {
  closeDbConnection,
  getDbConnection,
} from '@src/utils';
import { walletIdProxyHandler } from '@src/commons';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import errorHandler from '@src/api/middlewares/errorHandler';

const mysql = getDbConnection();

/*
 * Check if the wallet has any transactions on addresses with index > 0
 *
 * This lambda is called by API Gateway on GET /wallet/addresses/has-transactions-outside-first-address
 */
export const get = middy(walletIdProxyHandler(async (walletId) => {
  const status = await getWallet(mysql, walletId);

  if (!status) {
    return closeDbAndGetError(mysql, ApiError.WALLET_NOT_FOUND);
  }
  if (!status.readyAt) {
    return closeDbAndGetError(mysql, ApiError.WALLET_NOT_READY);
  }

  const hasTransactions = await hasTransactionsOnNonFirstAddress(mysql, walletId);

  await closeDbConnection(mysql);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      hasTransactions,
    }),
  };
})).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());
