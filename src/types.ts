/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export interface Block {
  txId: string;
  height: number;
}

export interface DecodedScript {
  type: string,
  address: string,
  timelock?: number,
}

export interface Input {
  value: number,
  tokenData: number,
  script: string,
  decoded: DecodedScript,
  token?: string,
}

export interface Output {
  value: number,
  tokenData: number,
  script: string,
  decoded: DecodedScript,
  token?: string,
  spentBy?: string,
}

export interface Token {
  uid: string,
  name: string,
  symbol: string,
}

export interface FullTx {
  txId: string,
  nonce: string,
  timestamp: number,
  version: number,
  weight: number,
  parents: string[],
  inputs: Input[],
  outputs: Output[],
  tokens?: Token[],
  raw: string,
}

export interface FullBlock {
  txId: string,
  version: number,
  weight: number,
  timestamp: number,
  isVoided: boolean,
  inputs: Input[],
  outputs: Output[],
  parents: string[],
  tokens?: Token[],
  height: number,
}

export interface ApiResponse {
  success: boolean;
  message?: string;
}

export interface DownloadBlockApiResponse extends ApiResponse {
  block: FullBlock;
}
