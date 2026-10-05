import {
  ShieldedOutputMode,
  isShieldedMode,
  RecoveryState,
  Bip32Account,
  checkShieldedOutputStorable,
} from '../src/shielded';

describe('ShieldedOutputMode', () => {
  it('numeric values match the wire format', () => {
    expect(ShieldedOutputMode.Transparent).toBe(0);
    expect(ShieldedOutputMode.AmountShielded).toBe(1);
    expect(ShieldedOutputMode.FullyShielded).toBe(2);
  });

  it('isShieldedMode returns true only for 1 and 2', () => {
    expect(isShieldedMode(0)).toBe(false);
    expect(isShieldedMode(1)).toBe(true);
    expect(isShieldedMode(2)).toBe(true);
    expect(isShieldedMode(3)).toBe(false);
  });

  it('RecoveryState enum has the three expected values', () => {
    expect(RecoveryState.Unowned).toBe('unowned');
    expect(RecoveryState.Recovered).toBe('recovered');
    expect(RecoveryState.RecoveryFailed).toBe('recovery_failed');
  });

  it('Bip32Account numeric values match the derivation contract', () => {
    expect(Bip32Account.Legacy).toBe(0);
    expect(Bip32Account.CTScan).toBe(1);
    expect(Bip32Account.CTSpend).toBe(2);
  });
});

const hex = (bytes: number, fill = 'ab') => fill.repeat(bytes);

const amountOutput = (over: Record<string, unknown> = {}) => ({
  mode: ShieldedOutputMode.AmountShielded,
  script: hex(100),
  range_proof: hex(200),
  token_data: 1,
  decoded: { address: 'W'.repeat(34) },
  ...over,
});

describe('checkShieldedOutputStorable', () => {
  it('accepts an output within every limit', () => {
    expect(checkShieldedOutputStorable(amountOutput())).toStrictEqual({ storable: true });
  });

  it('rejects the satellite when the script exceeds its column', () => {
    const result = checkShieldedOutputStorable(amountOutput({ script: hex(1025) }));

    expect(result.storable).toBe(false);
    expect(result).toMatchObject({ scope: 'satellite' });
    expect((result as { reason: string }).reason).toContain('script');
  });

  it('accepts a proof larger than the protocol cap but within its column', () => {
    // Consensus-invalid but storable: parking it would lose a valid output
    // whenever hathor-core and the pinned wallet-lib disagree on the cap.
    expect(checkShieldedOutputStorable(amountOutput({ range_proof: hex(5000) })))
      .toStrictEqual({ storable: true });
  });

  it('rejects the satellite when a proof exceeds its BLOB column', () => {
    expect(checkShieldedOutputStorable(amountOutput({ range_proof: hex(65536) })))
      .toMatchObject({ storable: false, scope: 'satellite' });
    expect(checkShieldedOutputStorable({
      mode: ShieldedOutputMode.FullyShielded,
      script: hex(100),
      range_proof: hex(200),
      surjection_proof: hex(65536),
      decoded: { address: 'W'.repeat(34) },
    })).toMatchObject({ storable: false, scope: 'satellite' });
  });

  it('rejects the satellite when token_data does not fit its column', () => {
    expect(checkShieldedOutputStorable(amountOutput({ token_data: 256 })))
      .toMatchObject({ storable: false, scope: 'satellite' });
    expect(checkShieldedOutputStorable(amountOutput({ token_data: -1 })))
      .toMatchObject({ storable: false, scope: 'satellite' });
  });

  it('rejects the whole output when the address does not fit its column', () => {
    // `address` is the one field on tx_output itself, so the row cannot be
    // stored at all — not even as a failed recovery.
    expect(checkShieldedOutputStorable(amountOutput({ decoded: { address: 'W'.repeat(35) } })))
      .toMatchObject({ storable: false, scope: 'output' });
  });
});
