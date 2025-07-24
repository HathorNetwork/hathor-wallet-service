/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import 'source-map-support/register';

import Joi, { ValidationResult } from 'joi';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { STATUS_CODE_TABLE, warmupMiddleware } from '@src/api/utils';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import errorHandler from '@src/api/middlewares/errorHandler';
import { walletIdProxyHandler } from '@src/commons';
import { FullnodeGetNCHistoryAPIParams, FullnodeGetNCStateAPIParams } from '@src/types';
import { ApiError } from './errors';
import fullnode from '@src/fullnode';

const GetNCStateAPIParams = Joi.object({
  id: Joi.string().required(),
  fields: Joi.array().items(Joi.string()).required(),
  balances: Joi.array().items(Joi.string()).required(),
  calls: Joi.array().items(Joi.string()).required(),
  block_hash: Joi.string(),
  block_height: Joi.number(),
});

const GetNCHistoryAPIParams = Joi.object({
  id: Joi.string().required(),
  count: Joi.number().allow(null),
  after: Joi.number().allow(null),
  before: Joi.number().allow(null),
});

const GetNCBpInfoAPIParams = Joi.object({
  blueprint_id: Joi.string().required(),
});

/*
 * Proxy to fullnode /v1a/nano_contract/state
 *
 * This lambda is called by API Gateway on POST /wallet/proxy/nano_contract/state
 */
export const getState: APIGatewayProxyHandler = middy(walletIdProxyHandler((async (_walletId, event) => {
  const params = event.queryStringParameters || {};
  const validationResult: ValidationResult = GetNCStateAPIParams.validate(params);

  if (validationResult.error) {
    const body = {
      success: false,
      details: validationResult.error.details.map(err => ({ message: err.message, path: err.path})),
    };
    return {
      statusCode: STATUS_CODE_TABLE[ApiError.INVALID_PAYLOAD],
      body: JSON.stringify(body),
    };
  }

  const data = await fullnode.getNCState(validationResult.value as FullnodeGetNCStateAPIParams);

  return {
    statusCode: 200,
    body: JSON.stringify(data),
  };
}))).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());

/*
 * Proxy to fullnode /v1a/nano_contract/history
 *
 * This lambda is called by API Gateway on POST /wallet/proxy/nano_contract/history
 */
export const getHistory: APIGatewayProxyHandler = middy(walletIdProxyHandler((async (_w, event) => {
  const params = event.queryStringParameters || {};
  const validationResult: ValidationResult = GetNCHistoryAPIParams.validate(params);

  if (validationResult.error) {
    const body = {
      success: false,
      details: validationResult.error.details.map(err => ({ message: err.message, path: err.path})),
    };
    return {
      statusCode: STATUS_CODE_TABLE[ApiError.INVALID_PAYLOAD],
      body: JSON.stringify(body),
    };
  }

  const data = await fullnode.getNCHistory(validationResult.value as FullnodeGetNCHistoryAPIParams);

  return {
    statusCode: 200,
    body: JSON.stringify(data),
  };
}))).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());

/*
 * Proxy to fullnode /v1a/nano_contract/blueprint/info
 *
 * This lambda is called by API Gateway on POST /wallet/proxy/nano_contract/blueprint/info
 */
export const getBlueprintInfo: APIGatewayProxyHandler = middy(walletIdProxyHandler((async (_w, event) => {
  const params = event.queryStringParameters || {};
  const validationResult: ValidationResult = GetNCBpInfoAPIParams.validate(params);

  if (validationResult.error) {
    const body = {
      success: false,
      details: validationResult.error.details.map(err => ({ message: err.message, path: err.path})),
    };
    return {
      statusCode: STATUS_CODE_TABLE[ApiError.INVALID_PAYLOAD],
      body: JSON.stringify(body),
    };
  }

  const data = await fullnode.getNCBlueprintInfo(validationResult.value.blueprint_id);

  return {
    statusCode: 200,
    body: JSON.stringify(data),
  };
}))).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());
