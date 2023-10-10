/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { createLogger, format, transports } from 'winston';

const SERVICE_NAME = process.env.SERVICE_NAME || 'wallet-service-daemon';

export default createLogger({
  level: process.env.CONSOLE_LEVEL || 'info',
  format: format.combine(
    format.colorize(),
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => (
      `${timestamp} [${SERVICE_NAME}][${level}]: ${message}`
    )),
  ),
  transports: [
    new transports.Console(),
  ],
});

