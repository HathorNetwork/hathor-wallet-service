/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { stopGLLBackgroundTask } from '@hathor/wallet-lib';

Object.defineProperty(global, '_bitcore', { get() { return undefined; }, set() {} });

stopGLLBackgroundTask();

