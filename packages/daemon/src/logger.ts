/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { createLogger, format, transports } from 'winston';
import getConfig from './config';

const { SERVICE_NAME, CONSOLE_LEVEL } = getConfig();

export default createLogger({
  level: CONSOLE_LEVEL,
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
