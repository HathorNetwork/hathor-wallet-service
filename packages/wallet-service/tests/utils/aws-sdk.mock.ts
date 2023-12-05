export const promiseMock = jest.fn();
export const invokeMock = jest.fn();
export const sendMock = jest.fn();
export const lambdaInvokeCommandMock = jest.fn();
export const lambdaClientMock = jest.fn().mockReturnValue({
  send: sendMock,
});

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: lambdaClientMock,
  InvokeCommand: lambdaInvokeCommandMock,
}));

export const newLambdaMock = jest.fn().mockReturnValue({
  invoke: invokeMock.mockReturnValue({
    promise: promiseMock.mockReturnValue({
      StatusCode: 202,
    }),
  }),
});

