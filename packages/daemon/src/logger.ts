/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { createLogger, format, transports } from 'winston';
import getConfig from './config';
import Transport from 'winston-transport';
import http from 'http';

const { SERVICE_NAME, CONSOLE_LEVEL } = getConfig();

const logHttpEndpoint = 'http://localhost:4000/logs'
class HttpLogTransport extends Transport {
  private endpoint: string;

  constructor(opts: any) {
    super(opts);
    this.endpoint = opts.endpoint || logHttpEndpoint;
  }

  log(info: any, callback: () => void) {
    setImmediate(() => this.emit('logged', info));
    const data = JSON.stringify({ ...info });
    const url = new URL(this.endpoint);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {});
    });
    req.on('error', (err) => {
      // Optionally handle errors
    });
    req.write(data);
    req.end();
    callback();
  }
}

export default createLogger({
  level: 'silly',
  format: format.combine(
    format.colorize(),
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => (
      `${timestamp} [${SERVICE_NAME}][${level}]: ${message}`
    )),
  ),
  transports: [
    new transports.Console(),
    new HttpLogTransport({ endpoint: logHttpEndpoint }),
  ],
});
