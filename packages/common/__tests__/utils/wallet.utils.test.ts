import { TokenVersion } from '@hathor/wallet-lib';
import { isDecodedValid, toTokenVersion } from '@src/utils/wallet.utils';

describe('walletUtils', () => {
  it('should validate common invalid inputs', () => {
    expect.hasAssertions();

    expect(isDecodedValid({})).toBeFalsy();
    expect(isDecodedValid(false)).toBeFalsy();
    expect(isDecodedValid(null)).toBeFalsy();
    expect(isDecodedValid(undefined)).toBeFalsy();
    expect(isDecodedValid({
      address: 'addr1',
      type: 'PPK',
    })).toBeTruthy();
  });

  it('should validate requiredKeys', () => {
    expect.hasAssertions();

    expect(isDecodedValid({
      address: 'addr1',
      type: 'PPK',
    }, ['address', 'type'])).toBeTruthy();

    expect(isDecodedValid({
      address: 'addr1',
    }, ['address', 'type'])).toBeFalsy();
  });
});

describe('toTokenVersion', () => {
  it('should convert valid TokenVersion.NATIVE (0)', () => {
    expect.hasAssertions();

    const result = toTokenVersion(0);
    expect(result).toBe(TokenVersion.NATIVE);
  });

  it('should convert valid TokenVersion.DEPOSIT (1)', () => {
    expect.hasAssertions();

    const result = toTokenVersion(1);
    expect(result).toBe(TokenVersion.DEPOSIT);
  });

  it('should convert valid TokenVersion.FEE (2)', () => {
    expect.hasAssertions();

    const result = toTokenVersion(2);
    expect(result).toBe(TokenVersion.FEE);
  });

  it('should throw error for invalid positive number', () => {
    expect.hasAssertions();

    expect(() => toTokenVersion(99)).toThrow('Invalid TokenVersion: 99');
  });

  it('should throw error for negative number', () => {
    expect.hasAssertions();

    expect(() => toTokenVersion(-1)).toThrow('Invalid TokenVersion: -1');
  });

  it('should throw error for non-integer number', () => {
    expect.hasAssertions();

    expect(() => toTokenVersion(1.5)).toThrow('Invalid TokenVersion: 1.5');
  });
});
