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

/**
 * Size of a compressed ephemeral pubkey. An output without one is stored as
 * this many zero bytes, the encoding hathor-core uses for "not present".
 */
export const EPHEMERAL_PUBKEY_BYTES = 33;

/**
 * Widths of the columns these fields are stored in. Kept next to the check so
 * the two cannot drift apart: `shielded_tx_output_data.script` is
 * VARBINARY(1024), `token_data` is TINYINT UNSIGNED, `range_proof` and
 * `surjection_proof` are BLOB, and both `tx_output.address` and
 * `address.address` are VARCHAR(34).
 */
const SCRIPT_COLUMN_MAX_BYTES = 1024;
const TOKEN_DATA_COLUMN_MAX = 255;
const BLOB_COLUMN_MAX_BYTES = 65535;
/** `tx_output.timelock` is INT UNSIGNED. */
const TIMELOCK_COLUMN_MAX = 4294967295;

/**
 * Width of `tx_output.address` and `address.address`. Exported because the
 * involvement set has to drop over-cap addresses too — they reach `address`
 * directly and would fail the same way.
 */
export const ADDRESS_COLUMN_MAX_CHARS = 34;

export type ShieldedStorageCheck =
  | { storable: true }
  /**
   * `scope: 'output'` — the violation is on `tx_output` itself, so no row can
   * be written for this output at all. `scope: 'satellite'` — `tx_output` is
   * fine but `shielded_tx_output_data` is not, so the output can be recorded
   * as a failed recovery without its crypto payload.
   */
  | { storable: false; scope: 'output' | 'satellite'; reason: string };

/** A field whose decoded bytes exceed its column. */
const overSized = (
  field: string, value: Buffer, max: number,
): { reason: string } | null => (
  value.length > max ? { reason: `${field} is ${value.length} bytes, column holds ${max}` } : null
);

/**
 * Whether a shielded output from the wire fits the columns it is stored in.
 *
 * Checked before any INSERT: under STRICT_TRANS_TABLES an over-cap field raises
 * an error inside the ingest transaction, which reaches the sync machine's
 * terminal ERROR state and halts sync permanently. Rejecting the single output
 * instead keeps the rest of the vertex ingesting.
 *
 * Covers every wire field that reaches a narrower column: `decoded.address`
 * and `decoded.timelock` on `tx_output`, and `script`, the two proofs and
 * `token_data` on the satellite. `commitment` and `asset_commitment` are
 * pinned to exactly 33 bytes by the Zod schema; `ephemeral_pubkey` is too when
 * present, and is stored as `EPHEMERAL_PUBKEY_BYTES` zero bytes when absent.
 * None of them can overflow their VARBINARY(33) columns, so they are not
 * re-checked here.
 *
 * The byte fields are taken already decoded, so the sizes measured are the
 * sizes stored, whatever encoding the wire uses.
 *
 * Every limit here is a *column* width, not a protocol cap. The protocol caps
 * (`MAX_RANGE_PROOF_SIZE`, `MAX_SURJECTION_PROOF_SIZE`) sit far below the BLOB
 * columns, so checking them would park consensus-valid outputs permanently
 * whenever hathor-core and the pinned wallet-lib disagree — the opposite of
 * what this guard is for.
 */
export const checkShieldedOutputStorable = (output: {
  mode: number;
  script: Buffer;
  range_proof: Buffer;
  surjection_proof?: Buffer | null;
  token_data?: number | null;
  decoded: { address: string; timelock?: number | null };
}): ShieldedStorageCheck => {
  const { address } = output.decoded;
  if (typeof address !== 'string' || address.length > ADDRESS_COLUMN_MAX_CHARS) {
    return {
      storable: false,
      scope: 'output',
      reason: typeof address !== 'string'
        ? 'decoded.address is missing or not a string'
        : `decoded.address is ${address.length} chars, column holds ${ADDRESS_COLUMN_MAX_CHARS}`,
    };
  }

  const { timelock } = output.decoded;
  if (timelock != null && (timelock < 0 || timelock > TIMELOCK_COLUMN_MAX)) {
    return {
      storable: false,
      scope: 'output',
      reason: `decoded.timelock is ${timelock}, column holds 0-${TIMELOCK_COLUMN_MAX}`,
    };
  }

  const sized = overSized('script', output.script, SCRIPT_COLUMN_MAX_BYTES)
    ?? overSized('range_proof', output.range_proof, BLOB_COLUMN_MAX_BYTES)
    ?? (output.surjection_proof
      ? overSized('surjection_proof', output.surjection_proof, BLOB_COLUMN_MAX_BYTES)
      : null);
  if (sized) {
    return { storable: false, scope: 'satellite', reason: sized.reason };
  }

  if (output.token_data != null
    && (output.token_data < 0 || output.token_data > TOKEN_DATA_COLUMN_MAX)) {
    return {
      storable: false,
      scope: 'satellite',
      reason: `token_data is ${output.token_data}, column holds 0-${TOKEN_DATA_COLUMN_MAX}`,
    };
  }

  return { storable: true };
};
