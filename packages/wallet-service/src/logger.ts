import { createLogger, format, transports, Logger } from 'winston';
import config from '@src/config';

const createDefaultLogger = (): Logger => createLogger({
  level: config.logLevel,
  format: format.json(),
  transports: [
    new transports.Console(),
  ],
});

export default createDefaultLogger;
