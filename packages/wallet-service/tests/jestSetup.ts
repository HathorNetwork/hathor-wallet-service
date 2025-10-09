/* eslint-disable @typescript-eslint/no-empty-function */
import { config } from 'dotenv';
import { stopGLLBackgroundTask } from '@hathor/wallet-lib';

Object.defineProperty(global, '_bitcore', { get() { return undefined; }, set() {} });

stopGLLBackgroundTask();
config();
