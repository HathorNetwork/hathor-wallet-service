import { stopGLLBackgroundTask } from '@hathor/wallet-lib';

Object.defineProperty(global, '_bitcore', { get() { return undefined; }, set() {} });

stopGLLBackgroundTask();

