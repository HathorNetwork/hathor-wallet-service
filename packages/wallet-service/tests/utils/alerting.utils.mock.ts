export const mockedAddAlert = jest.fn();
// Keep the module's other exports (the alert constants among them): code that
// reaches them through the common barrel would otherwise read `undefined`.
export default jest.mock('@wallet-service/common/src/utils/alerting.utils', () => ({
  ...jest.requireActual('@wallet-service/common/src/utils/alerting.utils'),
  addAlert: mockedAddAlert.mockReturnValue(Promise.resolve()),
}));
