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
 * the scan key lives on the `scan_privkey` blob attached to the matching
 * `CTSpend` row.
 *
 * The discriminator names the derivation path, not what kind of output the
 * address can appear on: addresses from any account can be the destination
 * of either transparent or shielded outputs (no on-chain signal tells the
 * payer which account the receiver derived their address from).
 *
 * - `Legacy` (0): legacy derivation path (m/44'/280'/0').
 * - `CTScan` (1): Confidential Transactions scan-key derivation
 *   (m/44'/280'/1'). Not stored as a row identifier; the derived
 *   `scan_privkey` is attached to the matching `CTSpend` row.
 * - `CTSpend` (2): Confidential Transactions spend-key derivation
 *   (m/44'/280'/2'). Produces P2PKH addresses that, when received as a
 *   shielded output, carry the long-form `ct_address` payload.
 */
export const Bip32Account = {
  Legacy: 0,
  CTScan: 1,
  CTSpend: 2,
} as const;
export type Bip32Account = (typeof Bip32Account)[keyof typeof Bip32Account];
