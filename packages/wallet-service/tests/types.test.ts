import { Authorities, Balance, TokenBalanceMap } from '@src/types';
import { DecodedOutput, TxInput, TxOutput } from '@wallet-service/common/src/types';

test('Authorities', () => {
  expect.hasAssertions();

  const a = new Authorities();
  expect(a.array).toHaveLength(Authorities.LENGTH);

  expect(new Authorities()).toStrictEqual(new Authorities([0, 0, 0, 0, 0, 0, 0, 0]));
  expect(new Authorities(0b0)).toStrictEqual(new Authorities([0]));
  expect(new Authorities(0b10000000)).toStrictEqual(new Authorities([1, 0, 0, 0, 0, 0, 0, 0]));
  expect(new Authorities(0b11111111)).toStrictEqual(new Authorities([1, 1, 1, 1, 1, 1, 1, 1]));

  // clone
  const b = new Authorities(0b101);
  expect(b.clone()).toStrictEqual(b);
  expect(b.clone()).not.toBe(b);

  // toInteger
  expect((new Authorities(0b0)).toInteger()).toBe(0b0);
  expect((new Authorities(0b10)).toInteger()).toBe(0b10);
  expect((new Authorities(0b11111111)).toInteger()).toBe(0b11111111);

  // toNegative
  expect((new Authorities([0, 0, 0, 0, 1, 0, -1, 0])).toNegative().array).toStrictEqual([0, 0, 0, 0, -1, 0, 1, 0]);

  // merge
  expect(Authorities.merge(new Authorities(0b0), new Authorities(0b1)).toInteger()).toBe(0b1);
  expect(Authorities.merge(new Authorities(0b0), new Authorities(0b11111111)).toInteger()).toBe(0b11111111);
  expect(Authorities.merge(new Authorities(0b01010101), new Authorities(0b10101010)).toInteger()).toBe(0b11111111);
  expect(Authorities.merge(new Authorities(0b11111111), new Authorities(0b11111111)).toInteger()).toBe(0b11111111);
  // with negative values
  expect(Authorities.merge(new Authorities([0, -1, 1]), new Authorities([-1, -1, -1]))).toStrictEqual(new Authorities([-1, -1, 0]));
});

test('Balance merge', () => {
  expect.hasAssertions();

  const b1 = new Balance(3n, 1n, 2n, null, new Authorities(0b01), new Authorities(0b00));
  const b2 = new Balance(7n, 3n, 4n, null, new Authorities(0b10), new Authorities(0b11));
  expect(Balance.merge(b1, b2)).toStrictEqual(new Balance(10n, 4n, 6n, null, new Authorities(0b11), new Authorities(0b11)));

  const b3 = new Balance(3n, 1n, 2n, 1000);
  const b4 = new Balance(7n, 3n, 4n);
  expect(Balance.merge(b3, b4)).toStrictEqual(new Balance(10n, 4n, 6n, 1000));
  expect(Balance.merge(b4, b3)).toStrictEqual(new Balance(10n, 4n, 6n, 1000));

  const b5 = new Balance(30n, 10n, 20n, 2000);
  expect(Balance.merge(b3, b5)).toStrictEqual(new Balance(33n, 11n, 22n, 1000));
  expect(Balance.merge(b5, b3)).toStrictEqual(new Balance(33n, 11n, 22n, 1000));
});

test('Balance total and authorities', () => {
  expect.hasAssertions();
  const b = new Balance(3n, 1n, 2n, null, new Authorities(0b01), new Authorities(0b10));
  expect(b.total()).toBe(3n);
  expect(b.authorities()).toStrictEqual(new Authorities(0b11));
});

test('TokenBalanceMap basic', () => {
  expect.hasAssertions();
  const t1 = new TokenBalanceMap();
  // return an empty balance
  expect(t1.get('token1')).toStrictEqual(new Balance());
  // add balance for a token and fetch it again
  const b1 = new Balance(14n, 5n, 9n, 1000);
  t1.set('token1', b1);
  expect(t1.get('token1')).toStrictEqual(b1);
  // balance for a different token should still be 0
  expect(t1.get('token2')).toStrictEqual(new Balance());
});

test('TokenBalanceMap clone', () => {
  expect.hasAssertions();
  const t1 = new TokenBalanceMap();
  t1.set('token1', new Balance(14n, 5n, 9n, 1000));
  const t2 = t1.clone();
  expect(t1).toStrictEqual(t2);
  expect(t1).not.toBe(t2);
  // should also clone balances
  expect(t1.get('token1')).not.toBe(t2.get('token1'));
});

test('TokenBalanceMap fromStringMap', () => {
  expect.hasAssertions();
  const t1 = new TokenBalanceMap();
  t1.set('token1', new Balance(15n, 0n, 15n));
  t1.set('token2', new Balance(5n, 2n, -3n, 1000));
  const t2 = TokenBalanceMap.fromStringMap({
    token1: { totalSent: 15n, unlocked: 0n, locked: 15n },
    token2: { totalSent: 5n, unlocked: 2n, locked: -3n, lockExpires: 1000 },
  });
  expect(t2).toStrictEqual(t1);
});

test('TokenBalanceMap merge', () => {
  expect.hasAssertions();
  const t1 = TokenBalanceMap.fromStringMap({
    token1: { totalSent: 10n, unlocked: 0n, locked: 10n },
    token2: { totalSent: 12n, unlocked: 5n, locked: 7n },
  });
  const t2 = TokenBalanceMap.fromStringMap({
    token1: { totalSent: 10n, unlocked: 2n, locked: -3n, lockExpires: 1000 },
    token3: { totalSent: 10n, unlocked: 9n, locked: 0n },
  });
  const merged = new TokenBalanceMap();
  merged.set('token1', new Balance(20n, 2n, 7n, 1000));
  merged.set('token2', new Balance(12n, 5n, 7n));
  merged.set('token3', new Balance(10n, 9n, 0n));
  expect(TokenBalanceMap.merge(t1, t2)).toStrictEqual(merged);

  // with null/undefined parameter
  expect(TokenBalanceMap.merge(t1, null)).toStrictEqual(t1);
  expect(TokenBalanceMap.merge(undefined, t1)).toStrictEqual(t1);

  // should clone the objects
  expect(TokenBalanceMap.merge(t1, null)).not.toBe(t1);
  expect(TokenBalanceMap.merge(undefined, t1)).not.toBe(t1);
});

test('TokenBalanceMap fromTxOutput fromTxInput', () => {
  expect.hasAssertions();
  const timelock = 1000;
  const decoded: DecodedOutput = {
    type: 'P2PKH',
    address: 'HCLqWoDJvprSnwwmr6huBg3bNR7DxjwXcD',
    timelock,
  };
  const txOutput: TxOutput = {
    value: 200n,
    token_data: 0,
    script: 'not-used',
    token: '00',
    spent_by: null,
    decoded,
    locked: false,
  };
  const txInput: TxInput = {
    tx_id: '00000000000000029411240dc4aea675b672c260f1419c8a3b87cfa203398098',
    index: 2,
    value: 200n,
    token_data: 0,
    script: 'not-used',
    token: '00',
    decoded,
  };

  expect(TokenBalanceMap.fromTxInput(txInput)).toStrictEqual(TokenBalanceMap.fromStringMap({ '00': { totalSent: 0n, unlocked: -txInput.value, locked: 0n } }));
  expect(TokenBalanceMap.fromTxOutput(txOutput)).toStrictEqual(TokenBalanceMap.fromStringMap({ '00': { totalSent: 200n, unlocked: txOutput.value, locked: 0n } }));

  // locked
  txOutput.locked = true;
  expect(TokenBalanceMap.fromTxOutput(txOutput)).toStrictEqual(TokenBalanceMap.fromStringMap({ '00': { totalSent: 200n, locked: txOutput.value, unlocked: 0n, lockExpires: timelock } }));
});
