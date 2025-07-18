import { APIGatewayProxyEvent, SNSEvent, SNSEventRecord } from 'aws-lambda';
import { ServerlessMysql } from 'serverless-mysql';
import { isEqual } from 'lodash';
import {
  DbSelectResult,
  TxOutputWithIndex,
  WalletBalanceValue,
  StringMap,
  PushProvider,
  DbTxOutput,
  FullNodeApiVersionResponse,
} from '@src/types';
import { TxInput } from '@wallet-service/common/src/types';
import { getWalletId } from '@src/utils';
import { addressUtils, walletUtils, Network, network, HathorWalletServiceWallet } from '@hathor/wallet-lib';
import {
  AddressTxHistoryTableEntry,
  AddressTableEntry,
  WalletBalanceEntry,
  WalletTableEntry,
  TokenTableEntry,
} from '@tests/types';
import { RedisClient } from 'redis';
import bitcore from 'bitcore-lib';
import Mnemonic from 'bitcore-mnemonic';

export const TEST_SEED = 'neither image nasty party brass oyster treat twelve olive menu invest title fan only rack draw call impact use curtain winner horn juice unlock';
// we'll use this xpubkey and corresponding addresses in some tests
export const XPUBKEY = 'xpub6CsZPtBWMkwxVxyBTKT8AWZcYqzwZ5K2qMkqjFpibMbBZ72JAvLMz7LquJNs4svfTiNYy6GbLo8gqECWsC6hTRt7imnphUFNEMz6VuRSjww';
export const AUTH_XPUBKEY = 'xpub6BBrYRzvafoaGsgPkrngKNcdRx2w33dL1fcyTxC9CbL8FChKfYyfTb5kLGwjgNrpb8Za9bws8UKkET1ZDJGUvooFk1UEJtssvC6qN987u1J';

export const TX_IDS = [
  '0000033139d08176d1051fb3a272c3610457f0c7f686afbe0afe3d37f966db85',
  '000003ae3be32b9df13157a27b77cf8e5fed3c20ad309a843002a10c5430c9cc',
  '000005cbcb8b29f74446a260cd7d36fab3cba1295ac9fe904795d7b064e0e53c',
  '0000000f1fbb4bd8a8e71735af832be210ac9a6c1e2081b21faeea3c0f5797f7',
  '00000649d769de25fcca204faaa23d4974d00fcb01130ab3f736fade4013598d',
  '000002e185a37162bbcb1ec43576056638f0fad43648ae070194d1e1105f339a',
  '00000597288221301f856e245579e7d32cea3e257330f9cb10178bb487b343e5',
];

export const ADDRESSES = [
  'HBCQgVR8Xsyv1BLDjf9NJPK1Hwg4rKUh62',
  'HPDWdurEygcubNMUUnTDUAzngrSXFaqGQc',
  'HEYCNNZZYrimD97AtoRcgcNFzyxtkgtt9Q',
  'HPTtSRrDd4ekU4ZQ2jnSLYayL8hiToE5D4',
  'HTYymKpjyXnz4ssEAnywtwnXnfneZH1Dbh',
  'HUp754aDZ7yKndw2JchXEiMvgzKuXasUmF',
  'HLfGaQoxssGbZ4h9wbLyiCafdE8kPm6Fo4',
  'HV3ox5B1Dai6Jp5EhV8DvUiucc1z3WJHjL',
  'HNWxs2bxgYtzfCpU6cJMGLgmqv7eGupTHr',
  'H9Ef7qteC4vAoVUYx5mvP9jCfmZgU9rSvL',
  'H7hxR75zsPzwfPWbrdkkFbKN2SiL2Lvyuw',
  'HVCa4QJbHB6pkqvNkmQZD2vpmwTYMNdzVo',
  'HBchgf1JLxwJzUg6epckK3YJn6Bq8XJMPV',
  'HVWf61fwoj9Dx15NvWicqXQgGMYVYedSx4',
  'H7PfxBmaqjoBisFRzpizoB9JcYSvoo8D2j',
  'HC1NXVzGcVAd84QMfFngHiKyK2K8SUiTaL',
  'HCqsSDrbs1cfqnF6QMUQkdGYXjEMyt9N3Y',
];

export const cleanDatabase = async (mysql: ServerlessMysql): Promise<void> => {
  const TABLES = [
    'address',
    'address_balance',
    'address_tx_history',
    'token',
    'tx_proposal',
    'transaction',
    'tx_output',
    'version_data',
    'wallet',
    'wallet_balance',
    'wallet_tx_history',
    'miner',
    'push_devices',
  ];
  await mysql.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of TABLES) {
    await mysql.query(`DELETE FROM ${table}`);
  }
  await mysql.query('SET FOREIGN_KEY_CHECKS = 1');
};

export const createOutput = (
  index: number,
  value: bigint,
  address: string,
  token = '00',
  timelock: number = null,
  locked = false,
  tokenData = 0,
  spentBy = null,
): TxOutputWithIndex => (
  {
    value,
    token,
    locked,
    index,
    decoded: {
      type: 'P2PKH',
      address,
      timelock,
    },
    token_data: tokenData,
    script: 'dqkUH70YjKeoKdFwMX2TOYvGVbXOrKaIrA==',
    spent_by: spentBy,
  }
);

export const createInput = (
  value: bigint,
  address: string,
  txId: string,
  index: number,
  token = '00',
  timelock = null,
  tokenData = 0,
): TxInput => (
  {
    value,
    token_data: tokenData,
    script: 'dqkUCEboPJo9txn548FA/NLLaMLsfsSIrA==',
    decoded: {
      type: 'P2PKH',
      address,
      timelock,
    },
    token,
    tx_id: txId,
    index,
  }
);

export const checkUtxoTable = async (
  mysql: ServerlessMysql,
  totalResults: number,
  txId?: string,
  index?: number,
  tokenId?: string,
  address?: string,
  value?: bigint,
  authorities?: number,
  timelock?: number | null,
  heightlock?: number | null,
  locked?: boolean,
  spentBy?: string | null,
  voided = false,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let results: DbSelectResult = await mysql.query('SELECT * FROM `tx_output` WHERE spent_by IS NULL');
  if (results.length !== totalResults) {
    return {
      error: 'checkUtxoTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`tx_output\`
     WHERE \`tx_id\` = ?
       AND \`index\` = ?
       AND \`token_id\` = ?
       AND \`address\` = ?
       AND \`value\` = ?
       AND \`authorities\` = ?
       AND \`locked\` = ?
       AND \`voided\` = ?
       AND \`timelock\``;
  results = await mysql.query(
    `${baseQuery} ${timelock ? '= ?' : 'IS ?'}
       AND \`heightlock\` ${heightlock ? '= ?' : 'IS ?'}
       AND \`spent_by\` ${spentBy ? '= ?' : 'IS ?'}
    `,
    [txId, index, tokenId, address, value, authorities, locked, voided, timelock, heightlock, spentBy],
  );
  if (results.length !== 1) {
    return {
      error: 'checkUtxoTable query',
      params: { txId, index, tokenId, address, value, authorities, timelock, heightlock, locked, spentBy, voided },
      results,
    };
  }
  return true;
};

export const checkAddressTable = async (
  mysql: ServerlessMysql,
  totalResults: number,
  address?: string,
  index?: number | null,
  walletId?: string | null,
  transactions?: number,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let results: DbSelectResult = await mysql.query('SELECT * FROM `address`');
  if (results.length !== totalResults) {
    return {
      error: 'checkAddressTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`address\`
     WHERE \`address\` = ?
       AND \`transactions\` = ?
       AND \`index\`
  `;
  const query = `${baseQuery} ${index !== null ? '= ?' : 'IS ?'} AND wallet_id ${walletId ? '= ?' : 'IS ?'}`;
  results = await mysql.query(
    query,
    [address, transactions, index, walletId],
  );
  if (results.length !== 1) {
    return {
      error: 'checkAddressTable query',
      params: { address, transactions, index, walletId },
      results,
    };
  }
  return true;
};

export const checkAddressBalanceTable = async (
  mysql: ServerlessMysql,
  totalResults: number,
  address: string,
  tokenId: string,
  unlocked: bigint,
  locked: bigint,
  lockExpires: number | null,
  transactions: number,
  unlockedAuthorities = 0,
  lockedAuthorities = 0,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let results: DbSelectResult = await mysql.query(`
    SELECT *
      FROM \`address_balance\`
  `);
  if (results.length !== totalResults) {
    return {
      error: 'checkAddressBalanceTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`address_balance\`
     WHERE \`address\` = ?
       AND \`token_id\` = ?
       AND \`unlocked_balance\` = ?
       AND \`locked_balance\` = ?
       AND \`transactions\` = ?
       AND \`unlocked_authorities\` = ?
       AND \`locked_authorities\` = ?`;

  results = await mysql.query(
    `${baseQuery} AND timelock_expires ${lockExpires === null ? 'IS' : '='} ?`, [
      address,
      tokenId,
      unlocked,
      locked,
      transactions,
      unlockedAuthorities,
      lockedAuthorities,
      lockExpires,
    ],
  );

  if (results.length !== 1) {
    return {
      error: 'checkAddressBalanceTable query',
      params: { address, tokenId, unlocked, locked, lockExpires, transactions, unlockedAuthorities, lockedAuthorities },
      results,
    };
  }
  return true;
};

export const checkAddressTxHistoryTable = async (
  mysql: ServerlessMysql,
  totalResults: number,
  address: string,
  txId: string,
  tokenId: string,
  balance: number,
  timestamp: number,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let results: DbSelectResult = await mysql.query('SELECT * FROM `address_tx_history`');
  expect(results).toHaveLength(totalResults);
  if (results.length !== totalResults) {
    return {
      error: 'checkAddressTxHistoryTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  // If we expect the table to be empty, we can return now.
  if (totalResults === 0) {
    return true;
  }

  // now fetch the exact entry
  results = await mysql.query(
    `SELECT *
       FROM \`address_tx_history\`
      WHERE \`address\` = ?
        AND \`tx_id\` = ?
        AND \`token_id\` = ?
        AND \`balance\` = ?
        AND \`timestamp\` = ?`,
    [
      address,
      txId,
      tokenId,
      balance,
      timestamp,
    ],
  );
  if (results.length !== 1) {
    return {
      error: 'checkAddressTxHistoryTable query',
      params: { address, txId, tokenId, balance, timestamp },
      results,
    };
  }
  return true;
};

export const checkWalletTable = async (mysql: ServerlessMysql,
  totalResults: number,
  id?: string,
  status?: string): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let results: DbSelectResult = await mysql.query('SELECT * FROM `wallet`');
  expect(results).toHaveLength(totalResults);
  if (results.length !== totalResults) {
    return {
      error: 'checkWalletTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // now fetch the exact entry
  results = await mysql.query(
    `SELECT *
       FROM \`wallet\`
      WHERE \`id\` = ?
        AND \`status\` = ?`,
    [id, status],
  );
  if (results.length !== 1) {
    return {
      error: 'checkWalletTable query',
      params: { id, status },
      results,
    };
  }
  return true;
};

export const checkWalletTxHistoryTable = async (mysql: ServerlessMysql,
  totalResults: number,
  walletId?: string,
  tokenId?: string,
  txId?: string,
  balance?: number,
  timestamp?: number): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let results: DbSelectResult = await mysql.query('SELECT * FROM `wallet_tx_history`');
  expect(results).toHaveLength(totalResults);
  if (results.length !== totalResults) {
    return {
      error: 'checkWalletTxHistoryTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // now fetch the exact entry
  results = await mysql.query(
    `SELECT *
       FROM \`wallet_tx_history\`
      WHERE \`wallet_id\` = ?
        AND \`token_id\` = ?
        AND \`tx_id\` = ?
        AND \`balance\` = ?
        AND \`timestamp\` = ?`,
    [
      walletId,
      tokenId,
      txId,
      balance,
      timestamp,
    ],
  );

  if (results.length !== 1) {
    return {
      error: 'checkWalletTxHistoryTable query',
      params: { walletId, tokenId, txId, balance, timestamp },
      results,
    };
  }
  return true;
};

export const checkWalletBalanceTable = async (
  mysql: ServerlessMysql,
  totalResults: number,
  walletId?: string,
  tokenId?: string,
  unlocked?: bigint,
  locked?: bigint,
  lockExpires?: number | null,
  transactions?: number,
  unlockedAuthorities = 0,
  lockedAuthorities = 0,
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let results: DbSelectResult = await mysql.query(`
    SELECT *
      FROM \`wallet_balance\`
  `);
  expect(results).toHaveLength(totalResults);
  if (results.length !== totalResults) {
    return {
      error: 'checkWalletBalanceTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`wallet_balance\`
     WHERE \`wallet_id\` = ?
       AND \`token_id\` = ?
       AND \`unlocked_balance\` = ?
       AND \`locked_balance\` = ?
       AND \`transactions\` = ?
       AND \`unlocked_authorities\` = ?
       AND \`locked_authorities\` = ?
  `;
  results = await mysql.query(
    `${baseQuery} AND timelock_expires ${lockExpires === null ? 'IS' : '='} ?`,
    [walletId, tokenId, unlocked, locked, transactions, unlockedAuthorities, lockedAuthorities, lockExpires],
  );
  if (results.length !== 1) {
    return {
      error: 'checkWalletBalanceTable query',
      params: { walletId, tokenId, unlocked, locked, lockExpires, transactions, unlockedAuthorities, lockedAuthorities },
      results,
    };
  }
  return true;
};

type Token = {
  tokenId: string;
  tokenSymbol: string;
  tokenName: string;
  transactions: number;
}

export const checkTokenTable = async (
  mysql: ServerlessMysql,
  totalResults: number,
  entries: Token[],
): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let results: DbSelectResult = await mysql.query('SELECT * FROM `token`');
  if (results.length !== totalResults) {
    return {
      error: 'checkTokenTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;

  // Fetch the exact entries
  const query = `
    SELECT id AS tokenId,
           symbol AS tokenSymbol,
           name AS tokenName,
           transactions
      FROM \`token\`
     WHERE \`id\` IN (?)
  `;
  results = await mysql.query(
    query,
    [entries.map((token) => token.tokenId)],
  );

  const invalidResults = results.filter((token: Token) => {
    const entry = entries.find(({ tokenId }) => tokenId === token.tokenId);

    if (!entry) {
      return true;
    }

    // token is a RowDataPacket, so just cast it to an object so we can
    // compare it
    if (!isEqual({ ...token }, entry)) {
      return true;
    }

    return false;
  });

  if (invalidResults.length > 0) {
    return {
      error: 'checkTokenTable query',
      params: entries,
      invalidResults,
    };
  }
  return true;
};

export const countTxOutputTable = async (
  mysql: ServerlessMysql,
): Promise<number> => {
  const results: DbSelectResult = await mysql.query(
    `SELECT COUNT(*) AS count
       FROM \`tx_output\`
      WHERE \`voided\` = FALSE`,
  );

  if (results.length > 0) {
    return Number(results[0].count);
  }

  return 0;
};

export const addToTransactionTable = async (
  mysql: ServerlessMysql,
  entries: unknown[][],
): Promise<void> => {
  await mysql.query(
    `INSERT INTO \`transaction\`(\`tx_id\`, \`timestamp\`,
                          \`version\`, \`voided\`,
                          \`height\`, \`weight\`)
     VALUES ?`,
    [entries],
  );
};

export const addToUtxoTable = async (
  mysql: ServerlessMysql,
  entries: DbTxOutput[],
): Promise<void> => {
  const payload = entries.map((entry: DbTxOutput) => ([
    entry.txId,
    entry.index,
    entry.tokenId,
    entry.address,
    entry.value,
    entry.authorities,
    entry.timelock || null,
    entry.heightlock || null,
    entry.locked,
    entry.spentBy || null,
    entry.txProposalId || null,
    entry.txProposalIndex,
    entry.voided || false,
  ]));
  await mysql.query(
    `INSERT INTO \`tx_output\`(
                   \`tx_id\`
                 , \`index\`
                 , \`token_id\`
                 , \`address\`
                 , \`value\`
                 , \`authorities\`
                 , \`timelock\`
                 , \`heightlock\`
                 , \`locked\`
                 , \`spent_by\`
                 , \`tx_proposal\`
                 , \`tx_proposal_index\`
                 , \`voided\`)
     VALUES ?`,
    [payload],
  );
};

export const addToWalletTable = async (
  mysql: ServerlessMysql,
  entries: WalletTableEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => [
    entry.id,
    entry.xpubkey,
    entry.highestUsedIndex || -1,
    entry.authXpubkey,
    entry.status,
    entry.maxGap,
    entry.createdAt,
    entry.readyAt,
  ]);
  await mysql.query(`
    INSERT INTO \`wallet\`(\`id\`, \`xpubkey\`,
                           \`last_used_address_index\`,
                           \`auth_xpubkey\`,
                           \`status\`, \`max_gap\`,
                           \`created_at\`, \`ready_at\`)
    VALUES ?`,
  [payload]);
};

export const addToWalletBalanceTable = async (
  mysql: ServerlessMysql,
  entries: WalletBalanceEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => ([
    entry.walletId,
    entry.tokenId,
    entry.unlockedBalance,
    entry.lockedBalance,
    entry.unlockedAuthorities,
    entry.lockedAuthorities,
    entry.timelockExpires,
    entry.transactions,
  ]));

  await mysql.query(`
    INSERT INTO \`wallet_balance\`(\`wallet_id\`, \`token_id\`,
                                   \`unlocked_balance\`, \`locked_balance\`,
                                   \`unlocked_authorities\`, \`locked_authorities\`,
                                   \`timelock_expires\`, \`transactions\`)
    VALUES ?`,
  [payload]);
};

export const addToWalletTxHistoryTable = async (
  mysql: ServerlessMysql,
  entries: unknown[][],
): Promise<void> => {
  await mysql.query(`
    INSERT INTO \`wallet_tx_history\`(\`wallet_id\`, \`tx_id\`,
                                      \`token_id\`, \`balance\`,
                                      \`timestamp\`, \`voided\`)
    VALUES ?`,
  [entries]);
};

export const addToAddressTable = async (
  mysql: ServerlessMysql,
  entries: AddressTableEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => ([
    entry.address,
    entry.index,
    entry.walletId,
    entry.transactions,
  ]));

  await mysql.query(`
    INSERT INTO \`address\`(\`address\`, \`index\`,
                            \`wallet_id\`, \`transactions\`)
    VALUES ?`,
  [payload]);
};

export const addToAddressTxHistoryTable = async (
  mysql: ServerlessMysql,
  entries: AddressTxHistoryTableEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => ([
    entry.address,
    entry.txId,
    entry.tokenId,
    entry.balance,
    entry.timestamp,
    entry.voided || false,
  ]));

  await mysql.query(`
    INSERT INTO \`address_tx_history\`(\`address\`, \`tx_id\`,
                                       \`token_id\`, \`balance\`,
                                       \`timestamp\`, \`voided\`)
    VALUES ?`,
  [payload]);
};

export const addToAddressBalanceTable = async (
  mysql: ServerlessMysql,
  entries: unknown[][],
): Promise<void> => {
  await mysql.query(`
    INSERT INTO \`address_balance\`(\`address\`, \`token_id\`,
                                    \`unlocked_balance\`, \`locked_balance\`,
                                    \`timelock_expires\`, \`transactions\`,
                                    \`unlocked_authorities\`, \`locked_authorities\`,
                                    \`total_received\`)
    VALUES ?`,
  [entries]);
};

export const addToTokenTable = async (
  mysql: ServerlessMysql,
  entries: TokenTableEntry[],
): Promise<void> => {
  const payload = entries.map((entry) => ([
    entry.id,
    entry.name,
    entry.symbol,
    entry.transactions,
  ]));

  await mysql.query(
    'INSERT INTO `token`(`id`, `name`, `symbol`, `transactions`) VALUES ?',
    [payload],
  );
};

export const addToTxProposalTable = async (
  mysql: ServerlessMysql,
  entries: unknown[][],
): Promise<void> => {
  await mysql.query(
    'INSERT INTO tx_proposal (`id`, `wallet_id`, `status`, `created_at`, `updated_at`) VALUES ?',
    [entries],
  );
};

export const makeGatewayEvent = (
  params: { [name: string]: string },
  body = null,
  multiValueQueryStringParameters = null,
): APIGatewayProxyEvent => ({
  body,
  queryStringParameters: params,
  pathParameters: params,
  headers: {},
  multiValueHeaders: {},
  httpMethod: '',
  isBase64Encoded: false,
  path: '',
  multiValueQueryStringParameters,
  stageVariables: null,
  requestContext: null,
  resource: null,
});

/*
 * The views protected by the bearer authorizer may use the `walletIdProxyHandler`
 * function that extracts the walletId from the requestContext and not from parameters.
 */
export const makeGatewayEventWithAuthorizer = (
  walletId: string,
  params: { [name: string]: string },
  body = null,
  multiValueQueryStringParameters: { [name: string]: string[] } = null,
): APIGatewayProxyEvent => ({
  body,
  queryStringParameters: params,
  pathParameters: params,
  headers: {
    origin: 'https://hathor.com/', // We add this origin to get the access-control-allow-origin header from middy
  },
  multiValueHeaders: {},
  httpMethod: '',
  isBase64Encoded: false,
  path: '',
  multiValueQueryStringParameters,
  stageVariables: null,
  requestContext: {
    authorizer: { principalId: walletId },
    accountId: '',
    apiId: '',
    httpMethod: '',
    identity: null,
    path: '',
    protocol: '',
    requestId: '',
    requestTimeEpoch: 0,
    resourceId: '',
    resourcePath: '',
    stage: '',
  },
  resource: null,
});

export function makeLoadWalletFailedSNSEvent(count: number, xpubkey: string, requestId?: string, errorMessage?: string): SNSEvent {
  const event: SNSEventRecord = {
    EventVersion: '',
    EventSubscriptionArn: '',
    EventSource: '',
    Sns: {
      SignatureVersion: '',
      Timestamp: '',
      Signature: '',
      SigningCertUrl: '',
      MessageId: '',
      Message: JSON.stringify({
        source: '',
        xpubkey,
        maxGap: 20,
      }),
      MessageAttributes: {
        RequestID: { Type: 'string', Value: requestId || 'request-id' },
        ErrorMessage: { Type: 'string', Value: errorMessage || 'error-message' },
      },
      Type: '',
      UnsubscribeUrl: '',
      TopicArn: '',
      Subject: '',
      Token: '',
    },
  };

  return {
    Records: Array(count).fill(event),
  };
}

export const addToVersionDataTable = async (mysql: ServerlessMysql, timestamp: number, versionData: FullNodeApiVersionResponse): Promise<void> => {
  const payload = [[ 1, timestamp, JSON.stringify(versionData) ]];

  await mysql.query(
    `INSERT INTO \`version_data\`(\`id\`, \`timestamp\`, \`data\`)
     VALUES ?`,
    [payload],
  );
};

export const checkVersionDataTable = async (mysql: ServerlessMysql, versionData: FullNodeApiVersionResponse): Promise<boolean | Record<string, unknown>> => {
  // first check the total number of rows in the table
  let results: DbSelectResult = await mysql.query('SELECT * FROM `version_data`');

  if (results.length > 1) {
    return {
      error: 'version_data total results',
      expected: 1,
      received: results.length,
      results,
    };
  }

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`version_data\`
     WHERE \`id\` = 1
  `;

  results = await mysql.query(baseQuery);

  if (results.length !== 1) {
    return {
      error: 'checkVersionDataTable query',
    };
  }

  const dbVersionData: FullNodeApiVersionResponse = JSON.parse(results[0].data as string);

  if (Object.entries(dbVersionData).toString() !== Object.entries(versionData).toString()) {
    return {
      error: 'checkVersionDataTable results don\'t match',
      expected: versionData,
      received: dbVersionData,
    };
  }

  return true;
};

export const redisAddKeys = (
  client: RedisClient,
  keyMapping: Record<string, string>,
): void => {
  const multi = client.multi();
  for (const [k, v] of Object.entries(keyMapping)) {
    multi.set(k, v);
  }
  multi.exec();
};

export const redisCleanup = (
  client: RedisClient,
): void => {
  client.flushdb();
};

export const getAuthData = (now: number): any => {
  // get the first address
  const xpubChangeDerivation = walletUtils.xpubDeriveChild(XPUBKEY, 0);
  const firstAddressData = addressUtils.deriveAddressFromXPubP2PKH(xpubChangeDerivation, 0, process.env.NETWORK);
  const firstAddress = firstAddressData.base58;

  // we need signatures for both the account path and the purpose path:
  const walletId = getWalletId(XPUBKEY);
  const xpriv = getXPrivKeyFromSeed(TEST_SEED, {
    passphrase: '',
    networkName: process.env.NETWORK,
  });

  // account path
  const accountDerivationIndex = '0\'';
  const derivedPrivKey = walletUtils.deriveXpriv(xpriv, accountDerivationIndex);
  const address = derivedPrivKey.publicKey.toAddress(network.getNetwork()).toString();
  const message = new bitcore.Message(String(now).concat(walletId).concat(address));
  const xpubkeySignature = message.sign(derivedPrivKey.privateKey);

  // auth purpose path (m/280'/280')
  const authDerivedPrivKey = HathorWalletServiceWallet.deriveAuthPrivateKey(xpriv);
  const authAddress = authDerivedPrivKey.publicKey.toAddress(network.getNetwork());
  const authMessage = new bitcore.Message(String(now).concat(walletId).concat(authAddress));
  const authXpubkeySignature = authMessage.sign(authDerivedPrivKey.privateKey);

  return {
    walletId,
    xpubkey: XPUBKEY,
    xpubkeySignature,
    authXpubkey: AUTH_XPUBKEY,
    authXpubkeySignature,
    firstAddress,
    timestamp: now,
  };
};

export const checkPushDevicesTable = async (
  mysql: ServerlessMysql,
  totalResults: number,
  filter?: {
    deviceId: string,
    walletId: string,
    pushProvider: string,
    enablePush: boolean,
    enableShowAmounts: boolean,
  },
): Promise<boolean | Record<string, unknown>> => {
  let results: DbSelectResult = await mysql.query('SELECT * FROM `push_devices`');
  if (!filter && results.length !== totalResults) {
    return {
      error: 'checkPushDevicesTable total results',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (totalResults === 0) return true;
  if (!filter) return true;

  // now fetch the exact entry
  const baseQuery = `
    SELECT *
      FROM \`push_devices\`
     WHERE \`wallet_id\` = ?
       AND \`device_id\` = ?
       AND \`push_provider\` = ?
       AND \`enable_push\` = ?
       AND \`enable_show_amounts\` = ?
      `;

  results = await mysql.query(baseQuery, [
    filter.walletId,
    filter.deviceId,
    filter.pushProvider,
    filter.enablePush,
    filter.enableShowAmounts,
  ]);

  if (results.length !== totalResults) {
    return {
      error: 'checkPushDevicesTable total results after filter',
      expected: totalResults,
      received: results.length,
      results,
    };
  }

  if (results.length !== 1) {
    return {
      error: 'checkPushDevicesTable query',
      params: { ...filter },
      results,
    };
  }
  return true;
};

/**
 * Builds a default value for StringMap<WalletBalanceValue>.
 */
export const buildWalletBalanceValueMap = (
  override?: Record<string, unknown>,
): StringMap<WalletBalanceValue> => ({
  wallet1: {
    walletId: 'wallet1',
    addresses: ['addr1'],
    txId: 'tx1',
    walletBalanceForTx: [
      {
        tokenId: 'token1',
        tokenSymbol: 'T1',
        lockExpires: null,
        lockedAmount: 0n,
        lockedAuthorities: {
          melt: false,
          mint: false,
        },
        total: 10n,
        totalAmountSent: 10n,
        unlockedAmount: 10n,
        unlockedAuthorities: {
          melt: false,
          mint: false,
        },
      },
    ],
  },
  ...override,
});

export const buildWallet = (overwrite?): WalletTableEntry => {
  const defaultWallet = {
    id: 'id',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  };

  return {
    ...defaultWallet,
    ...overwrite,
  };
};

export const buildPushRegister = (overwrite?): {
    deviceId: string,
    walletId: string,
    pushProvider: PushProvider,
    enablePush: boolean,
    enableShowAmounts: boolean,
    updatedAt: number,
} => {
  const defaultPushRegister = {
    deviceId: 'deviceId',
    walletId: 'walletId',
    pushProvider: PushProvider.ANDROID,
    enablePush: true,
    enableShowAmounts: true,
    updatedAt: new Date().getTime(),
  };

  return {
    ...defaultPushRegister,
    ...overwrite,
  };
};

export const insertPushDevice = async (mysql: ServerlessMysql, pushRegister: {
    deviceId: string,
    walletId: string,
    pushProvider: PushProvider,
    enablePush: boolean,
    enableShowAmounts: boolean,
    updatedAt: number,
}): Promise<void> => {
  await mysql.query(
    `
  INSERT
    INTO \`push_devices\` (
          device_id
        , wallet_id
        , push_provider
        , enable_push
        , enable_show_amounts
        , updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
          updated_at = CURRENT_TIMESTAMP`,
    [
      pushRegister.deviceId,
      pushRegister.walletId,
      pushRegister.pushProvider,
      pushRegister.enablePush,
      pushRegister.enableShowAmounts,
      pushRegister.updatedAt,
    ],
  );
};

export const daysAgo = (days) => new Date(new Date().getTime() - days * 24 * 60 * 60 * 1000);

bitcore.Networks.add({
  ...network.bitcoreNetwork,
  networkMagic: network.bitcoreNetwork.networkMagic.readUInt32BE(),
});

export const getXPrivKeyFromSeed = (
  seed: string,
  options: {
    passphrase?: string,
    networkName?: string
  } = {}): bitcore.HDPrivateKey => {
  const methodOptions = Object.assign({passphrase: '', networkName: 'mainnet'}, options);
  const { passphrase, networkName } = methodOptions;

  const network = new Network(networkName);
  const code = new Mnemonic(seed);
  return code.toHDPrivateKey(passphrase, network.bitcoreNetwork);
};
