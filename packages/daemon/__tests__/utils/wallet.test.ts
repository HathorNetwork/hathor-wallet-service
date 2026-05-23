/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Connection } from 'mysql2/promise';
import { EventTxOutput } from '../../src/types';
import { prepareOutputs, unlockUtxos } from '../../src/utils';
import {
  getDbConnection,
  getExpiredTimelocksUtxos,
  insertTxOutput,
} from '../../src/db';
import { cleanDatabase } from '../utils';
import { ShieldedOutputMode, RecoveryState } from '@wallet-service/common';

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

    // addr_t -> wallet_alice (transparent ownership lookup, bip32_account=0)
    await mysql.query(
      `INSERT INTO \`address\` (\`address\`, \`index\`, \`wallet_id\`, \`bip32_account\`, \`transactions\`)
       VALUES (?, 0, 'wallet_alice', 0, 1)`,
      ['addr_t'],
    );

    // addr_sr -> wallet_alice (shielded ownership lookup, bip32_account=1)
    await mysql.query(
      `INSERT INTO \`address\` (\`address\`, \`index\`, \`wallet_id\`, \`bip32_account\`, \`scan_privkey\`, \`transactions\`)
       VALUES (?, 0, 'wallet_alice', 1, ?, 1)`,
      ['addr_sr', Buffer.alloc(32, 0x42)],
    );

    // Pre-load wallet_balance: 100 transparent locked + 150 shielded locked.
    // updateWalletLockedBalance dispatches by `kind` — transparent batch
    // writes the transparent columns, shielded batch writes the shielded
    // columns — so each side has enough locked to absorb its own delta.
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
    // address_balance for the shielded address. Shielded amounts live on the
    // *_shielded_balance columns of the same unified (address, token_id) row.
    // The transparent unlock SQL today operates on the transparent columns
    // (shielded unlock that targets the *_shielded_balance columns is a
    // follow-up), so the row also seeds locked_balance = 150 on the
    // transparent columns to absorb the delta the current SQL applies.
    await mysql.query(
      `INSERT INTO \`address_balance\`
         (address, token_id, unlocked_balance, locked_balance,
          unlocked_shielded_balance, locked_shielded_balance,
          unlocked_authorities, locked_authorities,
          total_received, total_shielded_received, transactions)
       VALUES ('addr_sr', '00', 0, 150, 0, 150, 0, 0, 150, 150, 1)`,
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

    // wallet_balance: transparent batch moved 100 locked → unlocked;
    // shielded batch routed via `updateWalletLockedBalance(..., 'shielded')`
    // which writes to the *_shielded_balance columns, so shielded 150
    // moved locked_shielded → unlocked_shielded. The unowned shielded UTXO
    // contributes nothing (its value is unknown on this node).
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

    // address_balance: the transparent address's transparent columns
    // moved locked → unlocked. The shielded address's row went through
    // `updateAddressLockedBalance(..., 'shielded')`, which today still
    // writes the transparent columns (shielded unlock that targets
    // *_shielded_balance is a follow-up). Its transparent locked
    // therefore moved to transparent unlocked while the shielded
    // *_shielded_balance columns are untouched.
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
    expect(BigInt(byAddr.addr_sr.unlocked_balance)).toBe(150n);
    expect(BigInt(byAddr.addr_sr.locked_balance)).toBe(0n);
    expect(BigInt(byAddr.addr_sr.locked_shielded_balance)).toBe(150n);
  });
});
