/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';
import { addAlert, clearShieldedCryptoProvider, Severity } from '@wallet-service/common';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase } from '@tests/utils';
import {
  resetCtCryptoMock, primeAmountRewind, primeScanMiss, lastAmountRewindArgs,
} from '@tests/utils/ct-crypto-mock';
import { runShieldedSweep } from '@src/shieldedSweep';
import * as Recovery from '@src/shieldedRecovery';
import * as ShieldedDb from '@src/db/shielded';

// Each case runs whole sweeps against the database.
jest.setTimeout(30000);

jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: jest.fn().mockResolvedValue(undefined),
}));
const mockedAddAlert = addAlert as jest.Mock;

const mysql: ServerlessMysql = getDbConnection();
const logger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} } as unknown as Logger;
const plentyOfTime = () => 10 * 60_000;

const seedWallet = (id: string, ctStatus = 'ready') => mysql.query(
  `INSERT INTO \`wallet\` (\`id\`, \`xpubkey\`, \`auth_xpubkey\`, \`status\`, \`ct_status\`, \`max_gap\`, \`created_at\`, \`ready_at\`)
   VALUES (?, ?, ?, 'ready', ?, 20, 1, 1)`,
  [id, `xpub-${id}`, `auth-${id}`, ctStatus],
);

const seedCtSpendAddress = (address: string, walletId: string, catchupState: string) => mysql.query(
  `INSERT INTO \`address\` (\`address\`, \`index\`, \`wallet_id\`, \`transactions\`, \`bip32_account\`, \`scan_privkey\`, \`catchup_state\`)
   VALUES (?, 0, ?, 0, 2, ?, ?)`,
  [address, walletId, Buffer.alloc(32, 1), catchupState],
);

/** An unowned HTR output to `address`, with its satellite, primed to open for `value`. */
const seedOutput = async (txId: string, address: string, marker: number, value?: bigint) => {
  await mysql.query(
    'INSERT INTO `transaction` (`tx_id`, `timestamp`, `version`, `voided`) VALUES (?, 1000, 1, FALSE)', [txId],
  );
  await mysql.query(
    `INSERT INTO \`tx_output\`
       (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
        \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`mode\`, \`recovery_state\`)
     VALUES (?, 0, ?, NULL, '00', 0, NULL, NULL, FALSE, FALSE, 1, 'unowned')`,
    [txId, address],
  );
  await mysql.query(
    `INSERT INTO \`shielded_tx_output_data\`
       (\`tx_id\`, \`index\`, \`commitment\`, \`range_proof\`, \`script\`, \`ephemeral_pubkey\`, \`asset_commitment\`)
     VALUES (?, 0, ?, ?, ?, ?, NULL)`,
    [txId, Buffer.alloc(33, marker), Buffer.alloc(8), Buffer.alloc(1), Buffer.alloc(33, marker)],
  );
  if (value !== undefined) {
    primeAmountRewind({
      commitment: Buffer.alloc(33, marker), ephemeralPubkey: Buffer.alloc(33, marker), value, tokenUid: Buffer.alloc(32),
    });
  }
};

const stateOf = async (txId: string) => (await mysql.query(
  'SELECT `recovery_state` AS s FROM `tx_output` WHERE `tx_id` = ?', [txId],
) as unknown as { s: string }[])[0].s;
const catchupOf = async (address: string) => (await mysql.query(
  'SELECT `catchup_state` AS c FROM `address` WHERE `address` = ?', [address],
) as unknown as { c: string }[])[0].c;
const walletShielded = async (walletId: string) => {
  const rows = await mysql.query(
    "SELECT `unlocked_shielded_balance` AS b FROM `wallet_balance` WHERE `wallet_id` = ? AND `token_id` = '00'", [walletId],
  ) as unknown as { b: string }[];
  return rows.length === 0 ? 0n : BigInt(rows[0].b);
};

beforeEach(async () => {
  await cleanDatabase(mysql);
  resetCtCryptoMock();
  mockedAddAlert.mockClear();
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('runShieldedSweep', () => {
  it('recovers and credits the flagged outputs of a ready wallet, then marks it done', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('a1', 'w1', 'pending');
    await seedOutput('t1', 'a1', 0xa1, 100n);

    const outcome = await runShieldedSweep(mysql, logger, plentyOfTime, '');

    expect(outcome).toMatchObject({ wallets: 1, recovered: 1, failed: 0, missed: 0, errored: 0 });
    expect(await stateOf('t1')).toBe('recovered');
    expect(await walletShielded('w1')).toBe(100n);
    expect(await catchupOf('a1')).toBe('done');
  });

  it('leaves wallets and addresses nothing flagged alone', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('a1', 'w1', 'done');
    await seedOutput('t1', 'a1', 0xa1, 100n);
    // Still loading its shielded side: the load owns it.
    await seedWallet('w2', 'creating');
    await seedCtSpendAddress('a2', 'w2', 'pending');
    await seedOutput('t2', 'a2', 0xa2, 100n);

    const outcome = await runShieldedSweep(mysql, logger, plentyOfTime, '');

    expect(outcome.wallets).toBe(0);
    expect(await stateOf('t1')).toBe('unowned');
    expect(await stateOf('t2')).toBe('unowned');
  });

  it('rewinds only the outputs on flagged addresses of a selected wallet', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('a1', 'w1', 'pending');
    await seedOutput('t1', 'a1', 0xa1, 100n);
    // Same wallet, nothing flagged: settled already, not this run's business.
    await mysql.query(
      `INSERT INTO \`address\` (\`address\`, \`index\`, \`wallet_id\`, \`transactions\`, \`bip32_account\`, \`scan_privkey\`, \`catchup_state\`)
       VALUES ('a2', 1, 'w1', 0, 2, ?, 'done')`,
      [Buffer.alloc(32, 2)],
    );
    await seedOutput('t2', 'a2', 0xa2, 100n);

    await runShieldedSweep(mysql, logger, plentyOfTime, '');

    expect(await stateOf('t1')).toBe('recovered');
    expect(await stateOf('t2')).toBe('unowned');
  });

  it('changes nothing without a provider', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('a1', 'w1', 'pending');
    await seedOutput('t1', 'a1', 0xa1, 100n);
    clearShieldedCryptoProvider();

    const outcome = await runShieldedSweep(mysql, logger, plentyOfTime, '');

    expect(outcome.wallets).toBe(0);
    expect(await catchupOf('a1')).toBe('pending');
    expect(mockedAddAlert).not.toHaveBeenCalled();
  });

  it('picks up a wallet a dead sweep left running', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('a1', 'w1', 'running');
    await seedOutput('t1', 'a1', 0xa1, 100n);

    await runShieldedSweep(mysql, logger, plentyOfTime, '');

    expect(await stateOf('t1')).toBe('recovered');
    expect(await catchupOf('a1')).toBe('done');
  });

  it('keeps a flag the daemon sets again while the wallet is being swept', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('a1', 'w1', 'pending');
    await seedOutput('t1', 'a1', 0xa1, 100n);
    const real = ShieldedDb.getShieldedOutputsToRecover;
    const spy = jest.spyOn(ShieldedDb, 'getShieldedOutputsToRecover').mockImplementationOnce(async (...args) => {
      await mysql.query("UPDATE `address` SET `catchup_state` = 'pending' WHERE `address` = 'a1'");
      return real(...args);
    });

    await runShieldedSweep(mysql, logger, plentyOfTime, '');
    spy.mockRestore();

    expect(await stateOf('t1')).toBe('recovered');
    // Flagged again mid-run: the next run looks at it once more.
    expect(await catchupOf('a1')).toBe('pending');
  });

  it('tries a miss or a failure once per flag, not every run', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('a1', 'w1', 'pending');
    await seedOutput('miss', 'a1', 0xa1);
    primeScanMiss({ commitment: Buffer.alloc(33, 0xa1), ephemeralPubkey: Buffer.alloc(33, 0xa1) });
    await seedOutput('fail', 'a1', 0xa2); // not primed: the rewind fails

    const first = await runShieldedSweep(mysql, logger, plentyOfTime, '');
    resetCtCryptoMock();
    const second = await runShieldedSweep(mysql, logger, plentyOfTime, '');

    expect(first).toMatchObject({ wallets: 1, missed: 1, failed: 1 });
    expect(second.wallets).toBe(0);
    expect(lastAmountRewindArgs()).toBeNull();
  });

  it('alerts once for the run, paging unless every failure is sender-made', async () => {
    for (const id of ['w1', 'w2']) {
      await seedWallet(id);
      await seedCtSpendAddress(`a-${id}`, id, 'pending');
      await seedOutput(`t-${id}`, `a-${id}`, id === 'w1' ? 0xa1 : 0xa2); // both fail
    }

    await runShieldedSweep(mysql, logger, plentyOfTime, '');

    const alerts = mockedAddAlert.mock.calls.filter(([title]) => title === 'Shielded recovery failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0][2]).toBe(Severity.MAJOR);
    expect(alerts[0][3]).toMatchObject({ count: 2 });
    // No miss-pattern page: nothing the owner did started this run.
    expect(mockedAddAlert.mock.calls.map(([title]) => title))
      .not.toContain("Shielded outputs did not open with their wallet's scan key");
  });

  it('starts no wallet with too little time left', async () => {
    await seedWallet('w1');
    await seedCtSpendAddress('a1', 'w1', 'pending');
    await seedOutput('t1', 'a1', 0xa1, 100n);

    const outcome = await runShieldedSweep(mysql, logger, () => 1_000, '');

    expect(outcome.wallets).toBe(0);
    expect(await catchupOf('a1')).toBe('pending');
  });

  it('wraps round from its starting point to reach every wallet once', async () => {
    for (const id of ['wa', 'wb', 'wc']) {
      await seedWallet(id);
      await seedCtSpendAddress(`a-${id}`, id, 'pending');
      await seedOutput(`t-${id}`, `a-${id}`, id.charCodeAt(1), 1n);
    }

    const outcome = await runShieldedSweep(mysql, logger, plentyOfTime, 'wb');

    expect(outcome.wallets).toBe(3);
    for (const id of ['wa', 'wb', 'wc']) {
      expect(await stateOf(`t-${id}`)).toBe('recovered');
    }
  });

  it('moves on from a wallet whose commit keeps losing lock conflicts, leaving it flagged', async () => {
    for (const id of ['wa', 'wb']) {
      await seedWallet(id);
      await seedCtSpendAddress(`a-${id}`, id, 'pending');
      await seedOutput(`t-${id}`, `a-${id}`, id.charCodeAt(1), 1n);
    }
    const real = Recovery.commitShieldedRecoveries;
    const spy = jest.spyOn(Recovery, 'commitShieldedRecoveries').mockImplementation(async (tx, walletId, ...rest) => {
      if (walletId === 'wa') throw Object.assign(new Error('Deadlock found'), { errno: 1213 });
      return real(tx, walletId, ...rest);
    });

    const outcome = await runShieldedSweep(mysql, logger, plentyOfTime, '');
    spy.mockRestore();

    expect(outcome).toMatchObject({ wallets: 1, errored: 1 });
    expect(await stateOf('t-wa')).toBe('unowned');
    expect(await catchupOf('a-wa')).toBe('running');
    expect(await stateOf('t-wb')).toBe('recovered');
  });
});
