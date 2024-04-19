import { mockedAddAlert } from '@tests/utils/alerting.utils.mock';
import { initFirebaseAdminMock } from '@tests/utils/firebase-admin.mock';
import eventTemplate from '@events/eventTemplate.json';
import { loadWallet, loadWalletFailed } from '@src/api/wallet';
import { createWallet, getMinersList } from '@src/db';
import * as txProcessor from '@src/txProcessor';
import { WalletStatus } from '@src/types';
import { Transaction, TxInput, Severity } from '@wallet-service/common/src/types';
import { closeDbConnection, getDbConnection, getUnixTimestamp, getWalletId } from '@src/utils';
import { Logger } from 'winston';
import {
  ADDRESSES,
  XPUBKEY,
  AUTH_XPUBKEY,
  cleanDatabase,
  checkAddressTable,
  checkAddressBalanceTable,
  checkAddressTxHistoryTable,
  checkUtxoTable,
  checkWalletBalanceTable,
  checkWalletTable,
  checkWalletTxHistoryTable,
  createOutput,
  createInput,
  addToUtxoTable,
} from '@tests/utils';
import { SNSEvent } from 'aws-lambda';

const mysql = getDbConnection();

initFirebaseAdminMock();
const blockReward = 6400;
const htrToken = '00';
const walletId = getWalletId(XPUBKEY);
const now = getUnixTimestamp();
const maxGap = parseInt(process.env.MAX_ADDRESS_GAP, 10);
const OLD_ENV = process.env;

/*
 * xpubkey first addresses are: [
 *   'HBCQgVR8Xsyv1BLDjf9NJPK1Hwg4rKUh62',
 *   'HPDWdurEygcubNMUUnTDUAzngrSXFaqGQc',
 *   'HEYCNNZZYrimD97AtoRcgcNFzyxtkgtt9Q',
 *   'HPTtSRrDd4ekU4ZQ2jnSLYayL8hiToE5D4',
 *   'HTYymKpjyXnz4ssEAnywtwnXnfneZH1Dbh',
 *   'HUp754aDZ7yKndw2JchXEiMvgzKuXasUmF',
 *   'HLfGaQoxssGbZ4h9wbLyiCafdE8kPm6Fo4',
 *   'HV3ox5B1Dai6Jp5EhV8DvUiucc1z3WJHjL',
 * ]
 */

const blockEvent = JSON.parse(JSON.stringify(eventTemplate));
const block: Transaction = blockEvent.Records[0].body;
const txId1 = 'txId1';
block.tx_id = txId1;
block.timestamp = now;
block.height = 1;
block.outputs = [createOutput(0, blockReward, ADDRESSES[0])];

// receive another block. Reward from first block should now be unlocked
const blockEvent2 = JSON.parse(JSON.stringify(eventTemplate));
const block2: Transaction = blockEvent2.Records[0].body;
const txId2 = 'txId2';
block2.tx_id = txId2;
block2.timestamp = block.timestamp + 30;
block2.height = block.height + 1;
block2.outputs = [createOutput(0, blockReward, ADDRESSES[0])];

// block3 is from another miner
const blockEvent3 = JSON.parse(JSON.stringify(eventTemplate));
const block3: Transaction = blockEvent3.Records[0].body;
const anotherMinerTx = 'another_miner_tx';
block3.tx_id = anotherMinerTx;
block3.timestamp = block.timestamp + 60;
block3.height = block2.height + 1;
block3.outputs = [createOutput(0, blockReward, 'HTRuXktQiHvrfrwCZCPPBXNZK5SejgPneE')];

// block4 is from yet another miner
const blockEvent4 = JSON.parse(JSON.stringify(eventTemplate));
const block4: Transaction = blockEvent4.Records[0].body;
const yetAnotherMinerTx = 'yet_another_miner_tx';
block4.tx_id = yetAnotherMinerTx;
block4.timestamp = block.timestamp + 90;
block4.height = block3.height + 1;
block4.outputs = [createOutput(0, blockReward, 'HJPcaSncHGhzasvbbWP5yfZ6XSixwLHdHu')];

// tx sends first block rewards to 2 addresses on the same wallet
const txEvent = JSON.parse(JSON.stringify(eventTemplate));
const tx: Transaction = txEvent.Records[0].body;
const txId3 = 'txId3';
tx.version = 1;
tx.tx_id = txId3;
tx.timestamp += 20;
tx.inputs = [createInput(blockReward, ADDRESSES[0], txId1, 0)];
tx.outputs = [
  createOutput(0, blockReward - 5000, ADDRESSES[1]),
  createOutput(1, 5000, ADDRESSES[2]),
];

// tx sends one of last tx's outputs to 2 addresses, one of which is not from this wallet. Also, output sent to this wallet is locked
const txEvent2 = JSON.parse(JSON.stringify(eventTemplate));
const tx2: Transaction = txEvent2.Records[0].body;
const timelock = now + 90000;
tx2.version = 1;
const txId4 = 'txId4';
tx2.tx_id = txId4;
tx2.timestamp += 20;
tx2.inputs = [
  createInput(5000, ADDRESSES[2], txId2, 1),
];
tx2.outputs = [
  createOutput(0, 1000, ADDRESSES[6], '00', timelock),   // belongs to this wallet
  createOutput(1, 4000, 'HCuWC2qgNP47BtWtsTM48PokKitVdR6pch'),   // other wallet
];

// tx2Inputs on the format addToUtxoTable expects
const tx2Inputs = tx2.inputs.map((input: TxInput) => ({
  txId: input.tx_id,
  index: input.index,
  tokenId: input.token,
  address: input.decoded.address,
  value: input.value,
  authorities: null,
  timelock: null,
  heightlock: null,
  locked: false,
  spentBy: null,
}));

beforeEach(async () => {
  await cleanDatabase(mysql);
});

beforeAll(async () => {
  // modify env so block reward is unlocked after 1 new block (overrides .env file)
  jest.resetModules();
  process.env = { ...OLD_ENV };
  process.env.BLOCK_REWARD_LOCK = '1';

  const actualUtils = jest.requireActual('@src/utils');
  jest.mock('@src/utils', () => {
    return {
      ...actualUtils,
      assertEnvVariablesExistence: jest.fn()
    }
  });
});

afterAll(async () => {
  await closeDbConnection(mysql);
  // restore old env
  process.env = OLD_ENV;
});

test('load wallet, and simulate DLQ event', async () => {
  /*
   * create wallet
   */
  await createWallet(mysql, walletId, XPUBKEY, AUTH_XPUBKEY, maxGap);

  const REQUEST_ID = 'b45d912a-d392-4680-babf-c0caa6208a5f';

  const event: SNSEvent = {
      'Records': [
          {
              'EventSource': 'aws:sns',
              'EventVersion': '1.0',
              'EventSubscriptionArn': 'arn:aws:sns:eu-central-1:769498303037:',
              'Sns': {
                  'Type': 'Notification',
                  'MessageId': '1',
                  'TopicArn': 'arn',
                  'Subject': null,
                  'Message': `{\"xpubkey\":\"${XPUBKEY}\",\"maxGap\":20}`,
                  'Timestamp': '2024-03-19T15:12:24.741Z',
                  'SignatureVersion': '1',
                  'Signature': '',
                  'SigningCertUrl': '',
                  'UnsubscribeUrl': '',
                  'MessageAttributes': {
                      'RequestID': {
                          'Type': 'String',
                          'Value': REQUEST_ID,
                      },
                      'ErrorMessage': {
                          'Type': "String",
                          'Value': 'The lambda exploded',
                      },
                  },
              },
          },
      ]
  };

  await expect(checkWalletTable(mysql, 1, walletId, WalletStatus.CREATING)).resolves.toBe(true);

  await loadWalletFailed(event, null, null);

  await expect(checkWalletTable(mysql, 1, walletId, WalletStatus.ERROR)).resolves.toBe(true);

  expect(mockedAddAlert).toHaveBeenCalledWith(
    'A wallet failed to load in the wallet-service',
    `The wallet with id ${walletId} failed to load on the wallet-service. Please check the logs.`,
    Severity.MINOR,
    {
      walletId,
      RequestID: REQUEST_ID,
      ErrorMessage: 'The lambda exploded',
    },
    expect.any(Logger),
  );
}, 60000);
