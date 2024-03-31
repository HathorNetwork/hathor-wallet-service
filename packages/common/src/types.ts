/**
 * Alerts should follow the on-call guide for alerting, see
 * https://github.com/HathorNetwork/ops-tools/blob/master/docs/on-call/guide.md#alert-severitypriority
 */
export enum Severity {
  CRITICAL = 'critical',
  MAJOR = 'major',
  MEDIUM = 'medium',
  MINOR = 'minor',
  WARNING = 'warning',
  INFO = 'info',
}

export interface Transaction {
  // eslint-disable-next-line camelcase
  tx_id: string;
  nonce: number;
  timestamp: number;
  // eslint-disable-next-line camelcase
  signal_bits: number;
  version: number;
  weight: number;
  parents: string[];
  inputs: TxInput[];
  outputs: TxOutput[];
  height?: number;
  // eslint-disable-next-line camelcase
  token_name?: string;
  // eslint-disable-next-line camelcase
  token_symbol?: string;
}

export interface TxInput {
  // eslint-disable-next-line camelcase
  tx_id: string;
  index: number;
  value: number;
  // eslint-disable-next-line camelcase
  token_data: number;
  script: string;
  token: string;
  decoded: DecodedOutput;
}

export interface TxOutput {
  value: number;
  script: string;
  token: string;
  decoded: DecodedOutput;
  // eslint-disable-next-line camelcase
  spent_by: string | null;
  // eslint-disable-next-line camelcase
  token_data: number;
  locked?: boolean;
}

export interface DecodedOutput {
  type: string;
  address: string;
  timelock: number | null;
}
