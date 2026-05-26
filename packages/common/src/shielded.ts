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

/**
 * BIP32 account slots for Hathor wallet derivation. The numeric value of
 * `Legacy` and `CTSpend` is what gets persisted in `address.bip32_account`;
 * `CTScan` is documented for the scan-key derivation path even though no
 * column stores it — addresses are P2PKH-derived from the spend path, and
 * the scan key lives on the `scan_privkey` blob attached to the same row.
 *
 * The discriminator names the derivation path, not the output kind:
 * addresses from any account can appear on either transparent or shielded
 * outputs (no on-chain signal tells the payer which account the receiver
 * derived their address from).
 *
 * - `Legacy` (0): legacy derivation path (m/44'/280'/0').
 * - `CTSpend` (1): Confidential Transactions spend-key derivation
 *   (m/44'/280'/1'). Produces P2PKH addresses that can appear on shielded
 *   outputs (as the recovered spend_address) and on transparent outputs.
 * - `CTScan` (2): Confidential Transactions scan-key derivation
 *   (m/44'/280'/2'). Not stored as a row identifier; the derived
 *   `scan_privkey` is attached to the matching `CTSpend` row.
 */
export const Bip32Account = {
  Legacy: 0,
  CTSpend: 1,
  CTScan: 2,
} as const;
export type Bip32Account = (typeof Bip32Account)[keyof typeof Bip32Account];
