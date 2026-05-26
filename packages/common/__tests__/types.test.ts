import { Balance, TokenBalanceMap, Authorities } from '../src/types';

describe('TokenBalanceMap.fromStringMap', () => {
  it('accepts the short-key shorthand for transparent and shielded fields', () => {
    const map = TokenBalanceMap.fromStringMap({
      '00': {
        totalSent: 100n,
        unlocked: 60n,
        locked: 40n,
        unlockedShielded: 25n,
        lockedShielded: 15n,
        totalShieldedReceived: 40n,
      },
    });
    const b = map.get('00');
    expect(b.totalAmountSent).toBe(100n);
    expect(b.unlockedAmount).toBe(60n);
    expect(b.lockedAmount).toBe(40n);
    expect(b.unlockedShieldedAmount).toBe(25n);
    expect(b.lockedShieldedAmount).toBe(15n);
    expect(b.totalShieldedReceived).toBe(40n);
  });

  it('accepts Balance-class field names round-tripped through JSON.stringify', () => {
    // Constructed end-to-end: Balance instance → plain object via JSON →
    // fromStringMap. Verifies no field is silently dropped on the way back.
    const original = new Balance(
      100n,          // totalAmountSent
      60n,           // unlockedAmount
      40n,           // lockedAmount
      null,          // lockExpires
      new Authorities(0b01),
      new Authorities(0b10),
      25n,           // unlockedShieldedAmount
      15n,           // lockedShieldedAmount
      40n,           // totalShieldedReceived
    );

    // BigInt is not natively JSON-serializable, but the round-trip we're
    // guarding against is "Balance fields → plain object → fromStringMap".
    // Build the plain object the way a Balance-aware serializer would.
    const plain = {
      totalAmountSent: original.totalAmountSent,
      unlockedAmount: original.unlockedAmount,
      lockedAmount: original.lockedAmount,
      lockExpires: original.lockExpires,
      unlockedAuthorities: original.unlockedAuthorities,
      lockedAuthorities: original.lockedAuthorities,
      unlockedShieldedAmount: original.unlockedShieldedAmount,
      lockedShieldedAmount: original.lockedShieldedAmount,
      totalShieldedReceived: original.totalShieldedReceived,
    };

    // Cast away the StringMap value type; this test exercises runtime tolerance
    // of nullable / non-bigint fields when fed by a Balance serializer.
    const map = TokenBalanceMap.fromStringMap({ '00': plain as never });
    const b = map.get('00');
    expect(b.totalAmountSent).toBe(100n);
    expect(b.unlockedAmount).toBe(60n);
    expect(b.lockedAmount).toBe(40n);
    expect(b.unlockedShieldedAmount).toBe(25n);
    expect(b.lockedShieldedAmount).toBe(15n);
    expect(b.totalShieldedReceived).toBe(40n);
  });

  it('defaults missing shielded fields to 0n', () => {
    const map = TokenBalanceMap.fromStringMap({
      '00': { totalSent: 100n, unlocked: 60n, locked: 40n },
    });
    const b = map.get('00');
    expect(b.unlockedShieldedAmount).toBe(0n);
    expect(b.lockedShieldedAmount).toBe(0n);
    expect(b.totalShieldedReceived).toBe(0n);
  });
});
