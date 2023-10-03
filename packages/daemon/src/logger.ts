/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import util from 'util';
import * as winston from 'winston';

const CONSOLE_LEVEL = process.env.CONSOLE_LEVEL || 'info';

const myFormat = winston.format.printf(
  ({ level, message, ...args }) => {
    let argsStr = '';

    if (Object.keys(args).length > 0) {
      // Adapted from https://github.com/winstonjs/logform/blob/master/pretty-print.js
      const stripped = { ...args };

      argsStr = util.inspect(stripped, {
        compact: true,
        breakLength: Infinity,
      });
    }

    return `${Date.now()} [wallet-service-daemon] ${level}: ${message} ${argsStr}`;
  },
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
    winston.format.errors({ stack: true }),
  ),
  defaultMeta: { service: 'wallet-service-daemon' },
  transports,
});

export default logger;
