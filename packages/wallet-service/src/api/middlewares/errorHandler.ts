/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import createDefaultLogger from "@src/logger"

const logger = createDefaultLogger();

const errorHandler = () => {
   const onError = async (request) => {
    logger.error(request.error);

    if (process.env.NODE_ENV === 'production') {
      request.response = request.response ?? {}
      request.response.statusCode = 500;
      request.response.body = "Internal Server Error";
      return request.response;
    }

    request.response = request.response ?? {}
    request.response.statusCode = 500;
    request.response.body = request.error?.message || String(request.error);
    return request.response;
  }

  return { onError };
}

export default errorHandler;
