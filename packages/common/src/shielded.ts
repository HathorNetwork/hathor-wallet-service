/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Output mode discriminator. Maps directly to tx_output.mode (TINYINT)
 * and to the `mode` field on shielded outputs delivered by the fullnode.
 */
export const ShieldedOutputMode = {
  Transparent: 0,
  AmountShielded: 1,
  FullyShielded: 2,
} as const;
export type ShieldedOutputMode = (typeof ShieldedOutputMode)[keyof typeof ShieldedOutputMode];

export function isShieldedMode(mode: number): boolean {
  return mode === ShieldedOutputMode.AmountShielded || mode === ShieldedOutputMode.FullyShielded;
}

export type AddressKind = 'transparent' | 'shielded';

export function modeToKind(mode: number): AddressKind {
  return isShieldedMode(mode) ? 'shielded' : 'transparent';
}

/**
 * Recovery state for shielded tx_output rows. NULL on transparent rows.
 */
export const RecoveryState = {
  Unowned: 'unowned',
  Recovered: 'recovered',
  RecoveryFailed: 'recovery_failed',
} as const;
export type RecoveryState = (typeof RecoveryState)[keyof typeof RecoveryState];
