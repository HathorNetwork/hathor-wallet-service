/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import 'source-map-support/register';

import Joi from 'joi';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { Bip32Account } from '@wallet-service/common';
import { ApiError } from '@src/api/errors';
import { closeDbAndGetError, warmupMiddleware } from '@src/api/utils';
import {
  getWallet,
  getNewAddresses,
} from '@src/db';
import { closeDbConnection, getDbConnection } from '@src/utils';
import { ShortAddressInfo } from '@src/types';

import { walletIdProxyHandler } from '@src/commons';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import errorHandler from '@src/api/middlewares/errorHandler';

const mysql = getDbConnection();

const paramsSchema = Joi.object({
  legacy: Joi.boolean().default(true),
});

/*
 * Get the addresses of a wallet to be used in new transactions
 * It returns the empty addresses after the last used one
 *
 * By default it returns the Legacy (account 0) unused addresses. With
 * `?legacy=false` it returns the CTSpend (account 2) unused addresses under
 * `addresses` and keeps the Legacy ones under `legacyAddresses`.
 *
 * This lambda is called by API Gateway on GET /addresses/new
 */
export const get: APIGatewayProxyHandler = middy(walletIdProxyHandler(async (walletId, event) => {
  const params = event.queryStringParameters || {};

  const { value, error } = paramsSchema.validate(params, {
    abortEarly: false,
    convert: true, // query-string params always arrive as strings
  });

  if (error) {
    const details = error.details.map((err) => ({
      message: err.message,
      path: err.path,
    }));

    return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, { details });
  }

  const wallet = await getWallet(mysql, walletId);

  if (!wallet) {
    return closeDbAndGetError(mysql, ApiError.WALLET_NOT_FOUND);
  }
  if (!wallet.readyAt) {
    return closeDbAndGetError(mysql, ApiError.WALLET_NOT_READY);
  }

  // The short-info shape the endpoint returns; the internal `ctAddress` field is
  // never surfaced directly (it is remapped into its own list below).
  const toShortInfo = (entry: ShortAddressInfo) => ({
    address: entry.address,
    index: entry.index,
    addressPath: entry.addressPath,
  });

  if (value.legacy) {
    const legacyRows = await getNewAddresses(mysql, wallet, Bip32Account.Legacy);
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, addresses: legacyRows.map(toShortInfo) }),
    };
  }

  const ctSpendRows = await getNewAddresses(mysql, wallet, Bip32Account.CTSpend);
  const legacyRows = await getNewAddresses(mysql, wallet, Bip32Account.Legacy);

  await closeDbConnection(mysql);

  // For the CTSpend account we surface two parallel lists: `addresses` carries the
  // user-facing CT address, `spendAddresses` carries the on-chain spend address;
  // both share the same index and derivation path.
  const addresses = ctSpendRows.map((entry) => ({
    address: entry.ctAddress,
    index: entry.index,
    addressPath: entry.addressPath,
  }));
  const spendAddresses = ctSpendRows.map(toShortInfo);
  const legacyAddresses = legacyRows.map(toShortInfo);

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, addresses, spendAddresses, legacyAddresses }),
  };
})).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());
