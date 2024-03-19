export const mockedAssertEnvVariblesExistence = jest.fn();
const actualUtils = jest.requireActual('@src/utils');
jest.mock('@src/utils', () => {
  return {
    ...actualUtils,
    assertEnvVariablesExistence: mockedAssertEnvVariblesExistence
  }
});
export const mockedAddAlert = jest.fn();
export default jest.mock('@src/utils/alerting.utils', () => ({
  addAlert: mockedAddAlert.mockReturnValue(Promise.resolve()),
}));
