export const mockedAddAlert = jest.fn();
export default jest.mock('@src/utils/alerting.utils', () => {
  const originalModule = jest.requireActual('@src/utils/alerting.utils');

  return {
    ...originalModule,
    addAlert: mockedAddAlert.mockReturnValue(Promise.resolve()),
  };
});
