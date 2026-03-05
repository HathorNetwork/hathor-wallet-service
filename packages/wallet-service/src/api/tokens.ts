import 'source-map-support/register';

import { walletIdProxyHandler } from '@src/commons';
import {
  getWalletTokens,
} from '@src/db';
import {
  closeDbConnection,
  getDbConnection,
} from '@src/utils';
import { ApiError } from '@src/api/errors';
import { closeDbAndGetError, warmupMiddleware, txIdJoiValidator } from '@src/api/utils';
import fullnode from '@src/fullnode';
import Joi from 'joi';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import errorHandler from '@src/api/middlewares/errorHandler';

const mysql = getDbConnection();

/*
 * List wallet tokens
 *
 * This lambda is called by API Gateway on GET /wallet/tokens
 */
export const get = middy(walletIdProxyHandler(async (walletId) => {
  const walletTokens: string[] = await getWalletTokens(mysql, walletId);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      tokens: walletTokens,
    }),
  };
})).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());

const getTokenDetailsParamsSchema = Joi.object({
  token_id: txIdJoiValidator.required(),
});

/*
 * Get token details
 *
 * This lambda is called by API Gateway on GET /wallet/tokens/:token_id/details
 * It proxies the request to the fullnode's thin_wallet/token API
 */
export const getTokenDetails = middy(walletIdProxyHandler(async (_walletId, event) => {
  const params = event.pathParameters || {};

  const { value, error } = getTokenDetailsParamsSchema.validate(params, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    const details = error.details.map((err) => ({
      message: err.message,
      path: err.path,
    }));

    return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, { details });
  }

  const tokenId = value.token_id;

  try {
    const data = await fullnode.getTokenDetails(tokenId);

    if (!data?.success) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          success: false,
          error: ApiError.TOKEN_NOT_FOUND,
          details: [{ message: 'Token not found' }],
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        details: {
          tokenInfo: {
            id: tokenId,
            name: data.name,
            symbol: data.symbol,
            version: data.version,
          },
          totalSupply: data.total,
          totalTransactions: data.transactions_count,
          authorities: {
            mint: data.can_mint,
            melt: data.can_melt,
          },
        },
      }),
    };
  } finally {
    await closeDbConnection(mysql);
  }
})).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());
