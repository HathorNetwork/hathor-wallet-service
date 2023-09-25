/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
<<<<<<< HEAD
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

=======

import util from 'util';
import * as winston from 'winston';

const CONSOLE_LEVEL = process.env.CONSOLE_LEVEL || 'info';

const myFormat = winston.format.printf(
  ({ level, message, ...args }) => {
    let argsStr = '';

    if (Object.keys(args).length > 0) {
      // Adapted from https://github.com/winstonjs/logform/blob/master/pretty-print.js
      const stripped = Object.assign({}, args);

      argsStr = util.inspect(stripped, {
        compact: true,
        breakLength: Infinity,
      });
    }

    return `${Date.now()} [wallet-service-daemon] ${level}: ${message} ${argsStr}`;
  }
);

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(winston.format.colorize(), myFormat),
    level: CONSOLE_LEVEL,
  }),
];

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true })
  ),
  defaultMeta: { service: 'wallet-service-daemon' },
  transports: transports,
});

export default logger;
>>>>>>> 554cebd (feat: added sync machine to the project with mocked services)
