/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @jest-environment node
 */

import { APIGatewayProxyResult } from 'aws-lambda';
import hathorLib from '@hathor/wallet-lib';
import {
  create as txProposalCreate,
} from '@src/api/txProposalCreate';

import {
  send as txProposalSend,
} from '@src/api/txProposalSend';

import {
  addToWalletTable,
  addToAddressTable,
  addToUtxoTable,
  addToWalletBalanceTable,
  ADDRESSES,
  cleanDatabase,
  makeGatewayEventWithAuthorizer,
} from '@tests/utils';

import {
  closeDbConnection,
  getDbConnection,
} from '@src/utils';

import {
  getUtxos,
  getTxProposal,
} from '@src/db';

import { TxProposalStatus } from '@src/types';

const mysql = getDbConnection();

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('TxProposal UTXO unlocking on send failure', () => {
  test('UTXOs should be released when txProposalSend fails', async () => {
    expect.hasAssertions();

    // Create the spy to mock wallet-lib to force a failure
    const spy = jest.spyOn(hathorLib.axios, 'createRequestInstance');
    spy.mockReturnValue({
      post: () => {
        throw new Error('Network error - send failed');
      },
      // @ts-ignore
      get: () => Promise.resolve({
        data: {
          success: true,
          version: '0.38.0',
          network: 'mainnet',
          min_weight: 14,
          min_tx_weight: 14,
          min_tx_weight_coefficient: 1.6,
          min_tx_weight_k: 100,
          token_deposit_percentage: 0.01,
          reward_spend_min_blocks: 300,
          max_number_inputs: 255,
          max_number_outputs: 255,
        },
      }),
    });

    // Setup wallet
    await addToWalletTable(mysql, [{
      id: 'test-wallet',
      xpubkey: 'xpubkey',
      authXpubkey: 'auth_xpubkey',
      status: 'ready',
      maxGap: 5,
      createdAt: 10000,
      readyAt: 10001,
    }]);

    await addToAddressTable(mysql, [{
      address: ADDRESSES[0],
      index: 0,
      walletId: 'test-wallet',
      transactions: 1,
    }]);

    const tokenId = '00';
    const utxos = [{
      txId: '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50',
      index: 0,
      tokenId,
      address: ADDRESSES[0],
      value: 100n,
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      spentBy: null,
    }];

    await addToUtxoTable(mysql, utxos);
    await addToWalletBalanceTable(mysql, [{
      walletId: 'test-wallet',
      tokenId,
      unlockedBalance: 100n,
      lockedBalance: 0n,
      unlockedAuthorities: 0,
      lockedAuthorities: 0,
      timelockExpires: null,
      transactions: 1,
    }]);

    // Verify UTXO is initially unlocked (no tx_proposal_id)
    let utxoResults = await getUtxos(mysql, [{ txId: utxos[0].txId, index: utxos[0].index }]);
    expect(utxoResults).toHaveLength(1);
    expect(utxoResults[0].txProposalId).toBeNull();
    expect(utxoResults[0].txProposalIndex).toBeNull();

    // Create transaction
    const outputs = [
      new hathorLib.Output(
        100n,
        new hathorLib.P2PKH(new hathorLib.Address(
          ADDRESSES[0],
          { network: new hathorLib.Network(process.env.NETWORK) }
        )).createScript(),
        { tokenData: 0 }
      ),
    ];
    const inputs = [new hathorLib.Input(utxos[0].txId, utxos[0].index)];
    const transaction = new hathorLib.Transaction(inputs, outputs);
    const txHex = transaction.toHex();

    // Create tx proposal
    const createEvent = makeGatewayEventWithAuthorizer('test-wallet', null, JSON.stringify({ txHex }));
    const createResult = await txProposalCreate(createEvent, null, null) as APIGatewayProxyResult;

    expect(createResult.statusCode).toBe(201);
    const createBody = JSON.parse(createResult.body as string);
    expect(createBody.success).toBe(true);
    const txProposalId = createBody.txProposalId;

    // Verify UTXO is now locked with tx proposal ID
    utxoResults = await getUtxos(mysql, [{ txId: utxos[0].txId, index: utxos[0].index }]);
    expect(utxoResults).toHaveLength(1);
    expect(utxoResults[0].txProposalId).toBe(txProposalId);
    expect(utxoResults[0].txProposalIndex).toBe(0);

    // Attempt to send the transaction (this will fail due to our mock)
    const sendEvent = makeGatewayEventWithAuthorizer(
      'test-wallet',
      { txProposalId },
      JSON.stringify({ txHex })
    );
    const sendResult = await txProposalSend(sendEvent, null, null) as APIGatewayProxyResult;

    // Verify send failed and proposal status is SEND_ERROR
    expect(sendResult.statusCode).toBe(400);
    const sendBody = JSON.parse(sendResult.body as string);
    expect(sendBody.success).toBe(false);

    const txProposal = await getTxProposal(mysql, txProposalId);
    expect(txProposal!.status).toBe(TxProposalStatus.SEND_ERROR);

    // BUG: UTXO should be released when send fails, but currently it remains locked
    utxoResults = await getUtxos(mysql, [{ txId: utxos[0].txId, index: utxos[0].index }]);
    expect(utxoResults).toHaveLength(1);

    // THIS ASSERTION WILL FAIL because UTXOs are not released on send failure
    expect(utxoResults[0].txProposalId).toBeNull(); // Should be null (released)
    expect(utxoResults[0].txProposalIndex).toBeNull(); // Should be null (released)

    spy.mockRestore();
  });

  test('UTXOs should remain locked when txProposalSend succeeds', async () => {
    expect.hasAssertions();

    // Create the spy to mock wallet-lib to force success
    const spy = jest.spyOn(hathorLib.axios, 'createRequestInstance');
    spy.mockReturnValue({
      // @ts-ignore
      post: () => Promise.resolve({
        data: { success: true, hash: 'mocked-hash' }
      }),
      // @ts-ignore
      get: () => Promise.resolve({
        data: {
          success: true,
          version: '0.38.0',
          network: 'mainnet',
          min_weight: 14,
          min_tx_weight: 14,
          min_tx_weight_coefficient: 1.6,
          min_tx_weight_k: 100,
          token_deposit_percentage: 0.01,
          reward_spend_min_blocks: 300,
          max_number_inputs: 255,
          max_number_outputs: 255,
        },
      }),
    });

    // Setup wallet (same as above)
    await addToWalletTable(mysql, [{
      id: 'test-wallet',
      xpubkey: 'xpubkey',
      authXpubkey: 'auth_xpubkey',
      status: 'ready',
      maxGap: 5,
      createdAt: 10000,
      readyAt: 10001,
    }]);

    await addToAddressTable(mysql, [{
      address: ADDRESSES[0],
      index: 0,
      walletId: 'test-wallet',
      transactions: 1,
    }]);

    const tokenId = '00';
    const utxos = [{
      txId: '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50',
      index: 0,
      tokenId,
      address: ADDRESSES[0],
      value: 100n,
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      spentBy: null,
    }];

    await addToUtxoTable(mysql, utxos);
    await addToWalletBalanceTable(mysql, [{
      walletId: 'test-wallet',
      tokenId,
      unlockedBalance: 100n,
      lockedBalance: 0n,
      unlockedAuthorities: 0,
      lockedAuthorities: 0,
      timelockExpires: null,
      transactions: 1,
    }]);

    // Create transaction and proposal (same as above)
    const outputs = [
      new hathorLib.Output(
        100n,
        new hathorLib.P2PKH(new hathorLib.Address(
          ADDRESSES[0],
          { network: new hathorLib.Network(process.env.NETWORK) }
        )).createScript(),
        { tokenData: 0 }
      ),
    ];
    const inputs = [new hathorLib.Input(utxos[0].txId, utxos[0].index)];
    const transaction = new hathorLib.Transaction(inputs, outputs);
    const txHex = transaction.toHex();

    const createEvent = makeGatewayEventWithAuthorizer('test-wallet', null, JSON.stringify({ txHex }));
    const createResult = await txProposalCreate(createEvent, null, null) as APIGatewayProxyResult;
    const createBody = JSON.parse(createResult.body as string);
    const txProposalId = createBody.txProposalId;

    // Send the transaction (this will succeed due to our mock)
    const sendEvent = makeGatewayEventWithAuthorizer(
      'test-wallet',
      { txProposalId },
      JSON.stringify({ txHex })
    );
    const sendResult = await txProposalSend(sendEvent, null, null) as APIGatewayProxyResult;

    // Verify send succeeded and proposal status is SENT
    expect(sendResult.statusCode).toBe(200);
    const sendBody = JSON.parse(sendResult.body as string);
    expect(sendBody.success).toBe(true);

    const txProposal = await getTxProposal(mysql, txProposalId);
    expect(txProposal!.status).toBe(TxProposalStatus.SENT);

    // UTXOs should remain locked when send succeeds (they'll be spent when tx is processed)
    const utxoResults = await getUtxos(mysql, [{ txId: utxos[0].txId, index: utxos[0].index }]);
    expect(utxoResults).toHaveLength(1);
    expect(utxoResults[0].txProposalId).toBe(txProposalId); // Should remain locked
    expect(utxoResults[0].txProposalIndex).toBe(0); // Should remain locked

    spy.mockRestore();
  });
});
