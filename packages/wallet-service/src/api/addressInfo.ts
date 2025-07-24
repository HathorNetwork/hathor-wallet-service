/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import 'source-map-support/register';

import Joi, { ValidationError } from 'joi';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { ApiError } from '@src/api/errors';
import { closeDbAndGetError, warmupMiddleware } from '@src/api/utils';
import {
  getWallet,
  getWalletAddressDetail,
} from '@src/db';
import { closeDbConnection, getDbConnection } from '@src/utils';
import { walletIdProxyHandler } from '@src/commons';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import errorHandler from '@src/api/middlewares/errorHandler';

const mysql = getDbConnection();

interface AddressQueryRequest {
  address: string,
}

/**
 * Get the address info
 * This lambda is called by API Gateway on GET /address/info
 */
export const get: APIGatewayProxyHandler = middy(
  walletIdProxyHandler(async (walletId, event) => {
    const status = await getWallet(mysql, walletId);

    if (!status) {
      return closeDbAndGetError(mysql, ApiError.WALLET_NOT_FOUND);
    }

    if (!status.readyAt) {
      return closeDbAndGetError(mysql, ApiError.WALLET_NOT_READY);
    }

    const { value, error } = Joi.object({
      address: Joi.string().regex(/^[A-HJ-NP-Za-km-z1-9]*$/).min(34).max(35).required(),
    }).validate(event.queryStringParameters || {}) as { value: AddressQueryRequest, error: ValidationError };

    if (error) {
      const details = error.details.map((err) => ({
        message: err.message,
        path: err.path,
      }));

      return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, { details });
    }

    const { address } = value;
    console.log(`====================  Found ${address}`);
    let response = null;

    const info = await getWalletAddressDetail(mysql, walletId, address);

    if (!info) {
      // Address not found
      return closeDbAndGetError(mysql, ApiError.ADDRESS_NOT_FOUND);
    }

    await closeDbConnection(mysql);

    response = {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        data: info,
      }),
    };

    return response;
  }),
).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());
