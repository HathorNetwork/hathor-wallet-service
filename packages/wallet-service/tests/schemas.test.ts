import { FullnodeVersionSchema } from '@src/schemas';
import { defaultTestVersionData } from '@tests/utils';

// Regression guard for the testnet outage that motivated PR 420: the
// fullnode added `native_token.version` and the lambda crashed because the
// nested object did not allow it. Locking the modern payload in as a
// passing case prevents that fix from being reverted by accident.
test('FullnodeVersionSchema regression: native_token.version is accepted', () => {
  const payload = {
    ...defaultTestVersionData(),
    native_token: { name: 'Hathor', symbol: 'HTR', version: 0 },
  };
  const { error, value } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeUndefined();
  expect(value.native_token).toEqual({ name: 'Hathor', symbol: 'HTR', version: 0 });
});

test('FullnodeVersionSchema accepts a legacy fullnode payload without native_token.version', () => {
  // defaultTestVersionData() returns a payload whose native_token has no `version`.
  const { error } = FullnodeVersionSchema.validate(defaultTestVersionData());
  expect(error).toBeUndefined();
});

// Design-intent guard: native_token is intentionally strict — any unknown
// field there fails validation so a contract test (and not a production
// outage) surfaces fullnode schema drift.
test('FullnodeVersionSchema rejects unknown fields under native_token', () => {
  const payload = {
    ...defaultTestVersionData(),
    native_token: { name: 'Hathor', symbol: 'HTR', version: 0, icon: 'data:image/png;base64,...' },
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/native_token\.icon/);
});

test('FullnodeVersionSchema rejects a non-integer native_token.version', () => {
  const payload = {
    ...defaultTestVersionData(),
    native_token: { name: 'Hathor', symbol: 'HTR', version: 1.5 },
  };
  const { error } = FullnodeVersionSchema.validate(payload);
  expect(error).toBeDefined();
  expect(error!.message).toMatch(/native_token\.version/);
});
