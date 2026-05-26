import { ShieldedOutputMode, isShieldedMode, RecoveryState, Bip32Account } from '../src/shielded';

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
