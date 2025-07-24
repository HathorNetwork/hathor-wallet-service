/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import 'source-map-support/register';

import { APIGatewayProxyHandler } from 'aws-lambda';
import { warmupMiddleware } from '@src/api/utils';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import errorHandler from '@src/api/middlewares/errorHandler';
import axios from 'axios';
import config from '@src/config';

/*
 * Check if a list of addresses belong to the caller wallet
 *
 * This lambda is called by API Gateway on POST /addresses/check_mine
 */
export const getState: APIGatewayProxyHandler = middy((async (event) => {
  const response = await axios.get(`${config.defaultServer}/nano_contract/state`, { params: event.queryStringParameters });

  return {
    statusCode: response.status,
    body: JSON.stringify(response.data),
  };
})).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());

/*
 * Check if a list of addresses belong to the caller wallet
 *
 * This lambda is called by API Gateway on POST /addresses/check_mine
 */
export const getHistory: APIGatewayProxyHandler = middy((async (event) => {
  const response = await axios.get(`${config.defaultServer}/nano_contract/history`, { params: event.queryStringParameters });

  return {
    statusCode: response.status,
    body: JSON.stringify(response.data),
  };
})).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());

/*
 * Check if a list of addresses belong to the caller wallet
 *
 * This lambda is called by API Gateway on POST /addresses/check_mine
 */
export const getBlueprintInfo: APIGatewayProxyHandler = middy((async (event) => {
  const response = await axios.get(`${config.defaultServer}/nano_contract/blueprint/info`, { params: event.queryStringParameters });

  return {
    statusCode: response.status,
    body: JSON.stringify(response.data),
  };
})).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());
