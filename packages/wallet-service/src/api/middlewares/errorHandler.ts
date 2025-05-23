/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import middy from '@middy/core'
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'
import createDefaultLogger from "@src/logger"
import { STATUS_CODE_TABLE } from '@src/api/utils';
import { ApiError } from '@src/api/errors';

const logger = createDefaultLogger();

const defaultResponse: APIGatewayProxyResult = { statusCode: STATUS_CODE_TABLE[ApiError.INTERNAL_SERVER_ERROR], body: ApiError.INTERNAL_SERVER_ERROR };

const errorHandler = (): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> => {
   const onError: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = async (request)  => {
    logger.error(`[${request.context?.functionName}] Unhandled error on ${request.event?.path}: ${request.error}`);

    // Initialize response with default values if it hasn't been done yet.
    request.response = request.response ?? {...defaultResponse};
    // Force the status code to 500 since this is an unhandled error
    request.response.statusCode = STATUS_CODE_TABLE[ApiError.INTERNAL_SERVER_ERROR];

    // In production, we do not want to expose the error message to the user.
    if (process.env.NODE_ENV === 'production') {
      request.response.body = ApiError.INTERNAL_SERVER_ERROR;
      return request.response;
    }

    request.response.body = request.error?.message || String(request.error);
    return request.response;
  }

  return { onError };
}

export default errorHandler;
