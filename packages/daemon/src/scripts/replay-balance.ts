/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Balance replay script for debugging wallet_balance discrepancies.
 *
 * Reads events from a SQLite database produced by the event-downloader,
 * processes them in order using the daemon's own balance utilities, and
 * computes the expected HTR balance for a given set of addresses.
 *
 * Usage:
 *   node dist/scripts/replay-balance.js [options]
 *
 * Options:
 *   --db <path>          Path to events.sqlite (default: ./events.sqlite)
 *   --addresses <path>   Path to addresses CSV (default: ./addresses.csv)
 *   --expected <value>   Expected balance in hatoshis for comparison
 *   --verbose            Show per-transaction breakdown
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import { bigIntUtils, constants } from '@hathor/wallet-lib';
import { prepareOutputs, prepareInputs } from '../utils/wallet';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface Opts {
  db: string;
  addresses: string;
  expected?: bigint;
  verbose: boolean;
}

function parseArgs(): Opts {
  const args = process.argv.slice(2);
  const opts: Opts = {
    db: './events.sqlite',
    addresses: './addresses.csv',
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--db':        opts.db = args[++i]; break;
      case '--addresses': opts.addresses = args[++i]; break;
      case '--expected':  opts.expected = BigInt(args[++i]); break;
      case '--verbose':   opts.verbose = true; break;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadAddresses(csvPath: string): Set<string> {
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  // Skip header row
  return new Set(lines.slice(1).map(l => l.trim()).filter(Boolean));
}

interface TxState {
  hash: string;
  voided: boolean;
  outputs: any[];
  inputs: any[];
  tokens: string[];
  height: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs();

  const walletAddresses = loadAddresses(opts.addresses);
  console.log(`Loaded ${walletAddresses.size} wallet addresses`);

  const sqlite = new Database(opts.db, { readonly: true });

  // Build the WHERE clause — one LIKE condition per address
  const conditions = Array.from(walletAddresses)
    .map(addr => `data LIKE '%${addr}%'`)
    .join(' OR ');

  const rows = sqlite.prepare(`
    SELECT id, type, data
    FROM events
    WHERE type IN ('NEW_VERTEX_ACCEPTED', 'VERTEX_METADATA_CHANGED')
      AND (${conditions})
    ORDER BY id ASC
  `).all() as Array<{ id: number; type: string; data: string }>;

  sqlite.close();

  console.log(`Found ${rows.length} relevant events`);

  // ------------------------------------------------------------------
  // Pass 1: build the final state of each transaction.
  // Later events (VERTEX_METADATA_CHANGED) overwrite earlier ones so
  // the map always holds the most recent voided_by for each tx.
  // ------------------------------------------------------------------

  const txStates = new Map<string, TxState>();

  for (const row of rows) {
    const event = bigIntUtils.JSONBigInt.parse(row.data);
    const data = event.event.data;
    const hash: string = data.hash;
    const voided: boolean = data.metadata.voided_by.length > 0;

    txStates.set(hash, {
      hash,
      voided,
      outputs: data.outputs,
      inputs: data.inputs,
      tokens: data.tokens ?? [],
      height: data.metadata.height,
      timestamp: data.timestamp,
    });
  }

  console.log(`Unique transactions: ${txStates.size}`);

  // ------------------------------------------------------------------
  // Pass 2: build the spending map.
  // For each non-voided transaction, record which tx hash spends each
  // UTXO referenced by its inputs.
  // ------------------------------------------------------------------

  const spentBy = new Map<string, string>(); // "${txId}:${index}" -> spending tx hash

  for (const tx of txStates.values()) {
    if (tx.voided) continue;
    const inputs = prepareInputs(tx.inputs, tx.tokens);
    for (const input of inputs) {
      spentBy.set(`${input.tx_id}:${input.index}`, tx.hash);
    }
  }

  // ------------------------------------------------------------------
  // Pass 3: compute the wallet balance.
  // Sum the value of every unspent HTR output in a non-voided tx that
  // belongs to one of the wallet addresses.
  // ------------------------------------------------------------------

  let totalBalance = 0n;

  interface Contribution {
    hash: string;
    outputIndex: number;
    address: string;
    amount: bigint;
    height: number;
    timestamp: number;
  }

  const unspentUtxos: Contribution[] = [];

  for (const tx of txStates.values()) {
    if (tx.voided) continue;

    const outputs = prepareOutputs(tx.outputs, tx.tokens);

    for (const output of outputs) {
      const address = output.decoded?.address;
      if (!address || !walletAddresses.has(address)) continue;
      if (output.token !== constants.NATIVE_TOKEN_UID) continue;

      // Skip authority outputs (mint / melt)
      const isAuthority = (output.token_data & 0x80) !== 0;
      if (isAuthority) continue;

      const utxoKey = `${tx.hash}:${output.index}`;
      if (spentBy.has(utxoKey)) continue;

      totalBalance += BigInt(output.value as unknown as number);
      unspentUtxos.push({
        hash: tx.hash,
        outputIndex: output.index,
        address,
        amount: BigInt(output.value as unknown as number),
        height: tx.height,
        timestamp: tx.timestamp,
      });
    }
  }

  // ------------------------------------------------------------------
  // Output
  // ------------------------------------------------------------------

  if (opts.verbose) {
    console.log('\n--- Unspent HTR UTXOs ---');
    unspentUtxos
      .sort((a, b) => a.height - b.height)
      .forEach(u => {
        console.log(
          `  height=${u.height}  ${u.hash.substring(0, 16)}...  ` +
          `output[${u.outputIndex}]  ${u.address.substring(0, 8)}...  ` +
          `+${u.amount} hat`,
        );
      });
  }

  console.log('\n=== RESULTS ===');
  console.log(`Computed balance : ${totalBalance} hatoshis`);
  console.log(`Unspent UTXOs    : ${unspentUtxos.length}`);

  if (opts.expected !== undefined) {
    console.log(`Expected balance : ${opts.expected} hatoshis`);
    if (totalBalance === opts.expected) {
      console.log('✓  MATCH');
    } else {
      const diff = totalBalance - opts.expected;
      console.log(`✗  MISMATCH — diff: ${diff > 0n ? '+' : ''}${diff} hatoshis`);
    }
  }
}

main();
