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
    format.printf(({ timestamp, level, message, trace_id, span_id }) => {
      const traceInfo = trace_id ? ` [trace_id=${trace_id} span_id=${span_id}]` : '';
      return `${timestamp} [${SERVICE_NAME}][${level}]${traceInfo}: ${message}`;
    }),
  ),
  transports: [
    new transports.Console(),
  ],
});
