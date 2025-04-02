import { isDecodedValid } from '@src/utils/wallet.utils';

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
