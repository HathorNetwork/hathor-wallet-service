/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Get the current Unix timestamp, in seconds.
 *
 * @returns The current Unix timestamp in seconds
 */
export const getUnixTimestamp = (): number => (
  Math.round((new Date()).getTime() / 1000)
);


const daemonStartTime = getUnixTimestamp();

/**
 * Get the daemon uptime in seconds
 *
 * @returns The daemon uptime in seconds
 */
export const getDaemonUptime = (): number => (
  getUnixTimestamp() - daemonStartTime
);