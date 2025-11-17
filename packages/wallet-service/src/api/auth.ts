/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  APIGatewayProxyHandler,
  APIGatewayTokenAuthorizerHandler,
  CustomAuthorizerResult,
  PolicyDocument,
  Statement,
} from 'aws-lambda';
import { v4 as uuid4 } from 'uuid';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import { ApiError } from '@src/api/errors';
import { Wallet, WalletStatus } from '@src/types';
import { getWallet } from '@src/db';
import {
  verifySignature,
  getAddressFromXpub,
  closeDbConnection,
  getDbConnection,
  validateAuthTimestamp,
  AUTH_MAX_TIMESTAMP_SHIFT_IN_SECONDS,
  getWalletId,
} from '@src/utils';
import { warmupMiddleware } from '@src/api/utils';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import createDefaultLogger from '@src/logger';
import { Logger } from 'winston';
import config from '@src/config';
import errorHandler from '@src/api/middlewares/errorHandler';

const EXPIRATION_TIME_IN_SECONDS = 1800;
const READONLY_EXPIRATION_TIME_IN_SECONDS = 1800; // 30 minutes

const bodySchema = Joi.object({
  ts: Joi.number().positive().required(),
  xpub: Joi.string().required(),
  sign: Joi.string().required(),
  walletId: Joi.string().required(),
});

const readOnlyBodySchema = Joi.object({
  xpubkey: Joi.string().required(),
});

function parseBody(body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    return null;
  }
}

const mysql = getDbConnection();

export const tokenHandler: APIGatewayProxyHandler = middy(async (event) => {
  const eventBody = parseBody(event.body);

  const { value, error } = bodySchema.validate(eventBody, {
    abortEarly: false,
    convert: false,
  });

  if (error) {
    await closeDbConnection(mysql);

    const details = error.details.map((err) => ({
      message: err.message,
      path: err.path,
    }));

    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.INVALID_PAYLOAD,
        details,
      }),
    };
  }

  const signature = value.sign;
  const timestamp = value.ts;
  const authXpubStr = value.xpub;
  const wallet: Wallet = await getWallet(mysql, value.walletId);

  if (!wallet) {
    await closeDbConnection(mysql);
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.WALLET_NOT_FOUND,
      }),
    };
  }

  const [validTimestamp, timestampShift] = validateAuthTimestamp(timestamp, Date.now() / 1000);

  if (!validTimestamp) {
    const details = [{
      message: `The timestamp is shifted ${timestampShift}(s). Limit is ${AUTH_MAX_TIMESTAMP_SHIFT_IN_SECONDS}(s).`,
    }];

    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.AUTH_INVALID_SIGNATURE,
        details,
      }),
    };
  }

  if (wallet.authXpubkey !== authXpubStr) {
    const details = [{
      message: 'Provided auth_xpubkey does not match the stored auth_xpubkey',
    }];

    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.INVALID_PAYLOAD,
        details,
      }),
    };
  }

  const address = getAddressFromXpub(authXpubStr);
  const walletId = wallet.walletId;

  if (!verifySignature(signature, timestamp, address, walletId)) {
    await closeDbConnection(mysql);

    const details = {
      message: `The signature ${signature} does not match with the auth xpubkey ${authXpubStr} and the timestamp ${timestamp}`,
    };

    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.AUTH_INVALID_SIGNATURE,
        details,
      }),
    };
  }

  // To understand the other options to the sign method: https://github.com/auth0/node-jsonwebtoken#readme
  const token = jwt.sign(
    {
      sign: signature,
      ts: timestamp,
      addr: address.toString(),
      wid: walletId,
      mode: 'full',
    },
    config.authSecret,
    {
      expiresIn: EXPIRATION_TIME_IN_SECONDS,
      jwtid: uuid4(),
    },
  );

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, token }),
  };
}).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());

export const roTokenHandler: APIGatewayProxyHandler = middy(async (event) => {
  const eventBody = parseBody(event.body);

  const { value, error } = readOnlyBodySchema.validate(eventBody, {
    abortEarly: false,
    convert: false,
  });

  if (error) {
    await closeDbConnection(mysql);

    const details = error.details.map((err) => ({
      message: err.message,
      path: err.path,
    }));

    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.INVALID_PAYLOAD,
        details,
      }),
    };
  }

  const xpubkey = value.xpubkey;
  const walletId = getWalletId(xpubkey);

  // Check if wallet exists and is ready
  const wallet: Wallet = await getWallet(mysql, walletId);

  if (!wallet) {
    await closeDbConnection(mysql);
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.WALLET_NOT_FOUND,
      }),
    };
  }

  if (wallet.status !== WalletStatus.READY) {
    await closeDbConnection(mysql);
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.WALLET_NOT_READY,
      }),
    };
  }

  // Generate JWT with read-only mode
  // NOTE: JWT does NOT contain xpubkey, only walletId hash
  const token = jwt.sign(
    {
      wid: walletId,
      mode: 'ro',
    },
    config.authSecret,
    {
      expiresIn: READONLY_EXPIRATION_TIME_IN_SECONDS,
      jwtid: uuid4(),
    },
  );

  await closeDbConnection(mysql);

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, token }),
  };
}).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());

/**
 * Generates a aws policy document to allow/deny access to the resource
 */
const _generatePolicy = (principalId: string, effect: string, resource: string, logger: Logger, mode: string = 'full') => {
  const resourcePrefix = `${resource.split('/').slice(0, 2).join('/')}/*`;
  const policyDocument: PolicyDocument = {
    Version: '2012-10-17',
    Statement: [],
  };

  // Define resources based on mode
  let allowedResources: string[];

  if (mode === 'ro') {
    // Read-only endpoints
    allowedResources = [
      `${resourcePrefix}/wallet/status`,
      `${resourcePrefix}/wallet/addresses`,
      `${resourcePrefix}/wallet/addresses/new`,
      `${resourcePrefix}/wallet/balances`,
      `${resourcePrefix}/wallet/tokens`,
      `${resourcePrefix}/wallet/tokens/*/details`,
      `${resourcePrefix}/wallet/history`,
      `${resourcePrefix}/wallet/utxos`,
      `${resourcePrefix}/wallet/tx_outputs`,
      `${resourcePrefix}/wallet/transactions/*`,
      `${resourcePrefix}/wallet/address/info`,
      `${resourcePrefix}/wallet/proxy/*`,
    ];
  } else {
    // Full access
    allowedResources = [
      `${resourcePrefix}/wallet/*`,
      `${resourcePrefix}/tx/*`,
    ];
  }

  const statementOne: Statement = {
    Action: 'execute-api:Invoke',
    Effect: effect,
    Resource: allowedResources,
  };

  policyDocument.Statement[0] = statementOne;

  const authResponse: CustomAuthorizerResult = {
    policyDocument,
    principalId,
    context: { walletId: principalId, mode },
  };

  // XXX: to get the resulting policy on the logs, since we can't check the cached policy
  logger.info('Generated policy:', authResponse);
  return authResponse;
};

export const bearerAuthorizer: APIGatewayTokenAuthorizerHandler = middy(async (event) => {
  const logger = createDefaultLogger();
  const { authorizationToken } = event;
  if (!authorizationToken) {
    throw new Error('Unauthorized'); // returns a 401
  }
  const sanitizedToken = authorizationToken.replace(/Bearer /gi, '');
  let data;

  try {
    data = jwt.verify(
      sanitizedToken,
      config.authSecret,
    );
  } catch (e) {
    // XXX: find a way to return specific error to frontend or make all errors Unauthorized?
    //
    // Identify exception from jsonwebtoken by the name property
    // https://github.com/auth0/node-jsonwebtoken/blob/master/lib/TokenExpiredError.js#L5
    if (e.name === 'JsonWebTokenError') {
      throw new Error('Unauthorized');
    } else if (e.name === 'TokenExpiredError') {
      throw new Error('Unauthorized');
    } else {
      logger.warn('Error on bearerAuthorizer: ', e);
      throw e;
    }
  }

  const walletId = data.wid;
  const mode = data.mode || 'full'; // Default to full for legacy tokens

  // For full-access tokens, verify wallet signature (existing logic)
  if (mode === 'full') {
    const signature = data.sign;
    const timestamp = data.ts;
    const address = data.addr;
    const verified = verifySignature(signature, timestamp, address, walletId);

    if (!verified) {
      return _generatePolicy(walletId, 'Deny', event.methodArn, logger, mode);
    }
  }

  // For read-only tokens, JWT is already verified above - no wallet signature needed
  // Generate appropriate policy based on mode
  return _generatePolicy(walletId, 'Allow', event.methodArn, logger, mode);
}).use(cors())
  .use(warmupMiddleware());
