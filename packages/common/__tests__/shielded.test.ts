import { ShieldedOutputMode, isShieldedMode, modeToKind, RecoveryState } from '../src/shielded';

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

  it('modeToKind maps 0 to transparent and 1|2 to shielded', () => {
    expect(modeToKind(0)).toBe('transparent');
    expect(modeToKind(1)).toBe('shielded');
    expect(modeToKind(2)).toBe('shielded');
  });

  it('RecoveryState enum has the three expected values', () => {
    expect(RecoveryState.Unowned).toBe('unowned');
    expect(RecoveryState.Recovered).toBe('recovered');
    expect(RecoveryState.RecoveryFailed).toBe('recovery_failed');
  });
});
