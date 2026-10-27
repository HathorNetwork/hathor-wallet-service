/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Resolve when `promise` settles or `ms` elapses, whichever comes first.
 *
 * For waiting on an alert without letting it hold anything up: the SQS client
 * sets no timeout of its own, so a send can stay pending indefinitely.
 */
export const settleWithin = (promise: Promise<unknown>, ms: number): Promise<void> => (
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.finally(() => {
      clearTimeout(timer);
      resolve();
    }).catch(() => {});
  })
);
