/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Alerts should follow the on-call guide for alerting, see
 * https://github.com/HathorNetwork/ops-tools/blob/master/docs/on-call/guide.md#alert-severitypriority
 */
export enum Severity {
  CRITICAL = 'critical',
  MAJOR = 'major',
  MEDIUM = 'medium',
  MINOR = 'minor',
  WARNING = 'warning',
  INFO = 'info',
}
