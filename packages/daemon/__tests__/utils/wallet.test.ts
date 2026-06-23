/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Connection } from 'mysql2/promise';
import { constants } from '@hathor/wallet-lib';
import {
  EventTxHeader,
  EventTxInput,
  EventTxOutput,
  ShieldedOutput,
} from '../../src/types';
import {
  getInvolvedAddresses,
  getUnifiedBalanceMap,
  prepareInputs,
  prepareOutputs,
  unlockUtxos,
} from '../../src/utils';
import {
  getDbConnection,
  getExpiredTimelocksUtxos,
  insertTxOutput,
} from '../../src/db';
import { cleanDatabase } from '../utils';
import {
  ShieldedOutputMode,
  RecoveryState,
  TokenBalanceMap,
  TxInput,
  TxOutputWithIndex,
} from '@wallet-service/common';

/**
 * @jest-environment node
 */

describe('prepareOutputs', () => {
  it('should ignore NFT outputs', () => {
    const nftOutputs: EventTxOutput[] = [{
      value: 1n,
      token_data: 0,
      script: 'OmlwZnM6Ly9pcGZzL1FtTlJtNmhRUDN2MlVMclVOZTJQTTY4V1dRb2EyUmVwY1IxejVUVVdWZmd0bzGs',
      decoded: null
    }, {
      value: 2116n,
      token_data: 0,
      script: 'dqkUCU1EY3YLi8WURhDOEsspok4Y0XiIrA==',
      decoded: {
        type: 'P2PKH',
        address: 'H7NK2gjt5oaHzBEPoiH7y3d1NcPQi3Tr2F',
        timelock: null,
      }
    }, {
      value: 1n,
      token_data: 1,
      script: 'dqkUXO7BFkikXo2qwldGMeJlzyPSbtKIrA==',
      decoded: {
        type: 'P2PKH',
        address: 'HEzWZvoxDkZFnbmnK6BkQ8yw9xTyPXefGn',
        timelock: null,
      }
    }];

    const tokens = ['000013f562dc216890f247688028754a49d21dbb2b1f7731f840dc65585b1d57'];
    const preparedOutputs = prepareOutputs(nftOutputs, tokens);

    expect(preparedOutputs).toHaveLength(2);
    expect(preparedOutputs.find((output) => output.script === nftOutputs[0].script)).toBeUndefined();
  });
});

describe('unlockUtxos dispatch', () => {
  let mysql: Connection;

  beforeAll(async () => {
    try {
      mysql = await getDbConnection();
    } catch (e) {
      console.error('Failed to establish db connection', e);
      throw e;
    }
  });

  afterAll(() => {
    mysql.destroy();
  });

  beforeEach(async () => {
    await cleanDatabase(mysql);
  });

  it('flips locked=false for every row and dispatches balance updates by (mode, recovery_state)', async () => {
    expect.hasAssertions();

    // Seed three locked rows: transparent, shielded recovered, shielded unowned.
    await insertTxOutput(mysql, {
      tx_id: 'T_t',
      index: 0,
      mode: ShieldedOutputMode.Transparent,
      address: 'addr_t',
      value: 100n,
      token_id: '00',
      authorities: 0,
      timelock: 5,
      heightlock: null,
      locked: true,
      voided: false,
      recovery_state: null,
    });
    await insertTxOutput(mysql, {
      tx_id: 'T_sr',
      index: 0,
      mode: ShieldedOutputMode.AmountShielded,
      address: 'addr_sr',
      value: 150n,
      token_id: '00',
      authorities: 0,
      timelock: 5,
      heightlock: null,
      locked: true,
      voided: false,
      recovery_state: RecoveryState.Recovered,
    });
    await insertTxOutput(mysql, {
      tx_id: 'T_su',
      index: 0,
      mode: ShieldedOutputMode.AmountShielded,
      address: 'addr_su',
      value: null,
      token_id: '00',
      authorities: 0,
      timelock: 5,
      heightlock: null,
      locked: true,
      voided: false,
      recovery_state: RecoveryState.Unowned,
    });

    // Wallet that owns both addr_t (transparent) and addr_sr (shielded).
    await mysql.query(
      `INSERT INTO \`wallet\` (id, xpubkey, auth_xpubkey, status, max_gap, created_at, ready_at)
       VALUES ('wallet_alice', 'xpub123', 'xpub456', 'ready', 20, ?, ?)`,
      [Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)],
    );

    // addr_legacy -> wallet_alice (Legacy ownership, bip32_account = 0)
    await mysql.query(
      `INSERT INTO \`address\` (\`address\`, \`index\`, \`wallet_id\`, \`bip32_account\`, \`transactions\`)
       VALUES (?, 0, 'wallet_alice', 0, 1)`,
      ['addr_t'],
    );

    // addr_ctspend -> wallet_alice (CTSpend ownership, bip32_account = 2)
    await mysql.query(
      `INSERT INTO \`address\` (\`address\`, \`index\`, \`wallet_id\`, \`bip32_account\`, \`scan_privkey\`, \`transactions\`)
       VALUES (?, 0, 'wallet_alice', 2, ?, 1)`,
      ['addr_sr', Buffer.alloc(32, 0x42)],
    );

    // Pre-load wallet_balance: 100 transparent locked + 150 shielded locked.
    // The unified unlock SQL writes both column families in one statement;
    // each side's locked amount is what its own UTXO will decrement.
    await mysql.query(
      `INSERT INTO \`wallet_balance\`
         (wallet_id, token_id,
          unlocked_balance, locked_balance,
          unlocked_shielded_balance, locked_shielded_balance,
          total_received, total_shielded_received,
          unlocked_authorities, locked_authorities, transactions)
       VALUES ('wallet_alice', '00', 0, 100, 0, 150, 100, 150, 0, 0, 1)`,
    );

    // address_balance for the transparent address: 100 transparent locked.
    await mysql.query(
      `INSERT INTO \`address_balance\`
         (address, token_id, unlocked_balance, locked_balance,
          unlocked_shielded_balance, locked_shielded_balance,
          unlocked_authorities, locked_authorities,
          total_received, total_shielded_received, transactions)
       VALUES ('addr_t', '00', 0, 100, 0, 0, 0, 0, 100, 0, 1)`,
    );
    // address_balance for the shielded address: 150 shielded locked, no
    // transparent activity (addr_sr has only ever held shielded UTXOs).
    await mysql.query(
      `INSERT INTO \`address_balance\`
         (address, token_id, unlocked_balance, locked_balance,
          unlocked_shielded_balance, locked_shielded_balance,
          unlocked_authorities, locked_authorities,
          total_received, total_shielded_received, transactions)
       VALUES ('addr_sr', '00', 0, 0, 0, 150, 0, 0, 0, 150, 1)`,
    );

    // getExpiredTimelocksUtxos now returns rows of every mode (filter reverted).
    const expired = await getExpiredTimelocksUtxos(mysql, 10);
    expect(expired).toHaveLength(3);

    await unlockUtxos(mysql, expired, true);

    // Row-level lock flag flipped for all 3 rows, regardless of mode.
    const [lockedRows] = await mysql.query<any[]>(
      `SELECT COUNT(*) AS c
         FROM \`tx_output\`
        WHERE \`locked\` = TRUE
          AND \`tx_id\` IN (?, ?, ?)`,
      ['T_t', 'T_sr', 'T_su'],
    );
    expect(Number(lockedRows[0].c)).toBe(0);

    // wallet_balance: the unified unlock writes both column families in one
    // statement. Transparent UTXO (100) moves locked → unlocked on the
    // transparent columns; shielded recovered UTXO (150) moves
    // locked_shielded → unlocked_shielded on the shielded columns. The
    // unowned shielded UTXO contributes nothing (its value is unknown).
    const [walletBalanceRows] = await mysql.query<any[]>(
      `SELECT unlocked_balance, locked_balance,
              unlocked_shielded_balance, locked_shielded_balance
         FROM \`wallet_balance\`
        WHERE \`wallet_id\` = 'wallet_alice'
          AND \`token_id\` = '00'`,
    );
    expect(walletBalanceRows).toHaveLength(1);
    expect(BigInt(walletBalanceRows[0].unlocked_balance)).toBe(100n);
    expect(BigInt(walletBalanceRows[0].locked_balance)).toBe(0n);
    expect(BigInt(walletBalanceRows[0].unlocked_shielded_balance)).toBe(150n);
    expect(BigInt(walletBalanceRows[0].locked_shielded_balance)).toBe(0n);

    // address_balance: addr_t's transparent columns moved locked → unlocked.
    // addr_sr's shielded columns moved locked_shielded → unlocked_shielded;
    // its transparent columns are untouched (no transparent activity ever
    // happened on this shielded scan-path address in this test).
    const [addrBalanceRows] = await mysql.query<any[]>(
      `SELECT address, unlocked_balance, locked_balance,
              unlocked_shielded_balance, locked_shielded_balance
         FROM \`address_balance\`
        WHERE \`address\` IN (?, ?)
        ORDER BY \`address\``,
      ['addr_sr', 'addr_t'],
    );
    expect(addrBalanceRows).toHaveLength(2);
    const byAddr = Object.fromEntries(addrBalanceRows.map((r: any) => [r.address, r]));
    expect(BigInt(byAddr.addr_t.unlocked_balance)).toBe(100n);
    expect(BigInt(byAddr.addr_t.locked_balance)).toBe(0n);
    expect(BigInt(byAddr.addr_t.unlocked_shielded_balance)).toBe(0n);
    expect(BigInt(byAddr.addr_t.locked_shielded_balance)).toBe(0n);
    expect(BigInt(byAddr.addr_sr.unlocked_balance)).toBe(0n);
    expect(BigInt(byAddr.addr_sr.locked_balance)).toBe(0n);
    expect(BigInt(byAddr.addr_sr.unlocked_shielded_balance)).toBe(150n);
    expect(BigInt(byAddr.addr_sr.locked_shielded_balance)).toBe(0n);
  });
});

describe('getInvolvedAddresses', () => {
  const nanoHeader = (ncAddress: string): EventTxHeader => ({
    id: '10',
    nc_seqnum: 0,
    nc_id: 'nc1',
    nc_method: 'initialize',
    nc_address: ncAddress,
  });

  it('skips inputs that carry no spent_output', () => {
    const inputs = [{ tx_id: 't', index: 0 }] as unknown as EventTxInput[];
    expect(getInvolvedAddresses(inputs, [], [], []).size).toBe(0);
  });

  it('skips inputs and outputs whose decode failed (no address)', () => {
    const inputs = [{
      tx_id: 't',
      index: 0,
      spent_output: { mode: 0, value: 1n, token_data: 0, script: '', decoded: {} },
    }] as unknown as EventTxInput[];
    const outputs = [{
      value: 1n, token_data: 0, script: '', decoded: null,
    }] as unknown as EventTxOutput[];
    expect(getInvolvedAddresses(inputs, outputs, [], []).size).toBe(0);
  });

  it('skips shielded outputs with no decoded.address', () => {
    const shielded = [{ mode: 1, decoded: {} }] as unknown as ShieldedOutput[];
    expect(getInvolvedAddresses([], [], shielded, []).size).toBe(0);
  });

  it('adds the nano-header nc_address', () => {
    expect([...getInvolvedAddresses([], [], [], [nanoHeader('Hnano')])]).toEqual(['Hnano']);
  });

  it('dedupes an address that appears in multiple sources', () => {
    const addr = 'Hdup';
    const inputs = [{
      tx_id: 't',
      index: 0,
      spent_output: {
        mode: 0, value: 1n, token_data: 0, script: '',
        decoded: { type: 'P2PKH', address: addr, timelock: null },
      },
    }] as unknown as EventTxInput[];
    const outputs = [{
      value: 1n, token_data: 0, script: '',
      decoded: { type: 'P2PKH', address: addr, timelock: null },
    }] as unknown as EventTxOutput[];
    const shielded = [{ mode: 1, decoded: { address: addr } }] as unknown as ShieldedOutput[];

    expect([...getInvolvedAddresses(inputs, outputs, shielded, [])]).toEqual([addr]);
  });
});

describe('prepareInputs', () => {
  // A valid base64 P2PKH script — the Output model only stores the buffer,
  // so any base64 works for these filter/decode assertions.
  const P2PKH_SCRIPT_B64 = 'dqkUCU1EY3YLi8WURhDOEsspok4Y0XiIrA==';

  const transparentInput = (txId: string, tokenData: number, decoded: unknown): EventTxInput => ({
    tx_id: txId,
    index: 0,
    spent_output: {
      mode: 0,
      value: 100n,
      token_data: tokenData,
      script: P2PKH_SCRIPT_B64,
      decoded,
    },
  }) as unknown as EventTxInput;

  it('drops shielded inputs, keeping only the transparent ones', () => {
    const inputs = [
      transparentInput('t0', 0, { type: 'P2PKH', address: 'H1', timelock: null }),
      { tx_id: 't1', index: 0, spent_output: { mode: 1 } },
      { tx_id: 't2', index: 0, spent_output: { mode: 2 } },
    ] as unknown as EventTxInput[];

    const result = prepareInputs(inputs, []);
    expect(result).toHaveLength(1);
    expect(result[0].tx_id).toBe('t0');
  });

  it('resolves the token uid from the tokens array for a custom-token input', () => {
    const tokens = ['000013f562dc216890f247688028754a49d21dbb2b1f7731f840dc65585b1d57'];
    const result = prepareInputs(
      [transparentInput('t0', 1, { type: 'P2PKH', address: 'H1', timelock: null })],
      tokens,
    );
    expect(result).toHaveLength(1);
    expect(result[0].token).toBe(tokens[0]);
  });

  it('sets decoded to null for a transparent input with an invalid decode', () => {
    const result = prepareInputs([transparentInput('t0', 0, {})], []);
    expect(result).toHaveLength(1);
    expect(result[0].decoded).toBeNull();
  });
});

describe('getUnifiedBalanceMap (pure portions)', () => {
  // The shielded-input reversal is the only branch that touches the DB, and it
  // only runs for shielded `eventInputs`. These tests pass none, so the mysql
  // handle is never dereferenced.
  const noopMysql = {} as any;

  it('throws when an output has no decoded script', async () => {
    const outputs = [{
      value: 1n, script: '', token: '00', decoded: null,
      spent_by: null, token_data: 0, index: 0,
    }] as unknown as TxOutputWithIndex[];

    await expect(getUnifiedBalanceMap(noopMysql, [], outputs, [], [], []))
      .rejects.toThrow('Output has no decoded script');
  });

  it('throws when a decoded output has no address', async () => {
    const outputs = [{
      value: 1n, script: '', token: '00',
      decoded: { type: 'P2PKH', timelock: null },
      spent_by: null, token_data: 0, index: 0,
    }] as unknown as TxOutputWithIndex[];

    await expect(getUnifiedBalanceMap(noopMysql, [], outputs, [], [], []))
      .rejects.toThrow('Decoded output data has no address');
  });

  it('skips transparent inputs with an invalid decode', async () => {
    const inputs = [{
      tx_id: 't', index: 0, value: 1n, token_data: 0, script: '', token: '00', decoded: null,
    }] as unknown as TxInput[];

    const map = await getUnifiedBalanceMap(noopMysql, inputs, [], [], [], []);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('seeds an empty HTR entry for a nano-header address', async () => {
    const headers = [{
      id: '10', nc_seqnum: 0, nc_id: 'nc1', nc_method: 'initialize', nc_address: 'Hnano',
    }] as unknown as EventTxHeader[];

    const map = await getUnifiedBalanceMap(noopMysql, [], [], [], [], headers);
    expect(Object.keys(map)).toEqual(['Hnano']);
    expect(map.Hnano).toBeInstanceOf(TokenBalanceMap);
    expect(map.Hnano.get(constants.NATIVE_TOKEN_UID)).toBeDefined();
  });
});
