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
  timelock?: number | undefined | null;
  value?: number | undefined | null;
  tokenData?: number | undefined | null;
}

export interface Input {
  txId: string;
  value: number;
  tokenData: number;
  script: string;
  decoded: DecodedScript;
  index: number;
  token?: string | undefined | null;
}

export interface Output {
  value: number;
  tokenData: number;
  script: string;
  decoded: DecodedScript;
  token?: string | undefined | null;
  spentBy?: string | undefined | null;
}

export interface Token {
  uid: string;
  // Hathor will return name: null and symbol: null
  name: string | null;
  symbol: string | null;
}

export interface FullTx {
  txId: string;
  nonce: string;
  timestamp: number;
  version: number;
  weight: number;
  parents: string[];
  tokenName?: string | null;
  tokenSymbol?: string | null;
  inputs: Input[];
  outputs: Output[];
  tokens?: Token[];
  height?: number;
  raw?: string;
}

export interface FullBlock {
  txId: string;
  nonce?: string;
  timestamp: number;
  version: number;
  weight: number;
  parents: string[];
  tokenName?: string | null;
  tokenSymbol?: string | null;
  inputs: Input[];
  outputs: Output[];
  tokens?: Token[];
  height: number;
  raw?: string;
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

export interface HandlerEvent {
  type: string;
}

export type StatusEvent = {
  type: 'finished';
  success: boolean;
  message?: string;
} | {
  type: 'block_success';
  success: boolean;
  height?: number;
  blockId: string;
  message?: string;
  transactions: string[];
} | {
  type: 'transaction_failure';
  success: boolean;
  message?: string;
} | {
  type: 'reorg';
  success: boolean;
  message?: string;
} | {
  type: 'error';
  success: boolean;
  message?: string;
  error?: string;
}

/* export interface StatusEvent {
  type: string;
  success: boolean;
  blockId?: string;
  height?: number;
  transactions?: string[];
  message?: string;
  error?: string;
}; */

export interface GeneratorYieldResult<StatusEvent> {
  done?: boolean;
  value: StatusEvent;
}

export interface PreparedDecodedScript {
  type: string;
  address: string;
  timelock?: number | undefined | null;
  value?: number;
  token_data?: number;
}

export interface PreparedInput {
  value: number;
  token_data: number;
  script: string;
  decoded: PreparedDecodedScript;
  index: number;
  token: string;
}

export interface PreparedOutput {
  value: number;
  token_data: number;
  script: string;
  token: string;
  spent_by: string;
  decoded: PreparedDecodedScript;
}

export interface PreparedTx {
  tx_id: string;
  inputs: PreparedInput[];
  outputs: PreparedOutput[];
  timestamp: number;
  version: number;
  weight: number;
  parents: string[];
  nonce?: string;
  height?: number;
  tokens?: Token[];
  token_name?: string | null;
  token_symbol?: string | null;
  raw?: string;
}

export interface RawDecodedInput {
  type: string;
  address: string;
  timelock?: number | null;
  value: number;
  token_data: number;
}

export interface RawDecodedOutput {
  type: string;
  address: string;
  timelock?: number | null;
  value: number;
  token_data: number;
}

export interface RawInput {
  value: number;
  token_data: number;
  script: string;
  decoded: RawDecodedInput;
  tx_id: string;
  index: number;
}

export interface RawOutput {
  value: number;
  token_data: number;
  script: string;
  decoded: RawDecodedOutput;
}

export interface RawToken {
  uid: string;
  // Name and symbol can be null when the token is htr
  symbol?: string | null;
  name?: string | null;
}

export interface RawTx {
  hash: string;
  nonce: string;
  timestamp: number;
  version: number;
  weight: number;
  parents: string[];
  inputs: RawInput[];
  outputs: RawOutput[];
  tokens: RawToken[];
  token_name?: string | null;
  token_symbol?: string | null;
  raw: string;
}

export interface RawTxResponse {
  tx: RawTx;
  meta: any;
  success?: boolean;
  spent_outputs?: any;
}
