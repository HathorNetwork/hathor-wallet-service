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
  type: string;
  address: string;
  timelock?: number;
  value?: number;
  tokenData?: number;
}

export interface Input {
  txId: string;
  value: number;
  tokenData: number;
  script: string;
  decoded: DecodedScript;
  index: number;
  token?: string;
}

export interface Output {
  value: number;
  tokenData: number;
  script: string;
  decoded: DecodedScript;
  token?: string;
  spentBy?: string;
}

export interface Token {
  uid: string;
  name: string;
  symbol: string;
}

export interface FullTx {
  txId: string;
  nonce: string;
  timestamp: number;
  version: number;
  weight: number;
  parents: string[];
  inputs: Input[];
  outputs: Output[];
  tokens?: Token[];
  raw?: string;
}

export interface FullBlock {
  txId: string;
  version: number;
  weight: number;
  timestamp: number;
  isVoided: boolean;
  inputs: Input[];
  outputs: Output[];
  parents: string[];
  tokens?: Token[];
  height: number;
}

export interface ApiResponse {
  success: boolean;
  message?: string;
}

export interface DownloadBlockApiResponse extends ApiResponse {
  block: FullBlock;
}

export interface SyncSchema {
  states: {
    idle: {};
    syncing: {};
    failure: {};
    reorg: {};
  }
}

export interface SyncContext {
  hasMoreBlocks: boolean;
  error?: {};
}

/*
TODO: This is not being used in the machine, we should type all events.
export type SyncEvent =
  | { type: 'NEW_BLOCK'; message: any }
  | { type: 'STOP' };
*/

export interface StatusEvent {
  type: string;
  success: boolean;
  blockId?: string;
  height?: number;
  transactions?: string[];
  message?: string;
  error?: string;
};
