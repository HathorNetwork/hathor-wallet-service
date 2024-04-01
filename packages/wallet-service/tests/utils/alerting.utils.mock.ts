export const mockedAddAlert = jest.fn();
export default jest.mock('@wallet-service/common/src/utils/alerting.utils', () => ({
  addAlert: mockedAddAlert.mockReturnValue(Promise.resolve()),
}));
