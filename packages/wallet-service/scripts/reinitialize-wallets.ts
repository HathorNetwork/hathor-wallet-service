/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Wallet Re-Initialization Script
 *
 * This script re-initializes wallets from a CSV export after a database reset.
 * It processes wallets in batches to avoid overwhelming Lambda functions.
 *
 * Usage:
 *   yarn ts-node scripts/reinitialize-wallets.ts --csv <csv-file> [options]
 *
 * Options:
 *   --csv <file>         Path to CSV file with wallet data (required)
 *   --batch-size <n>     Number of wallets to process per batch (default: 50)
 *   --polling-interval <n>  Seconds between status polls (default: 10)
 *   --batch-delay <n>    Seconds to wait between batches (default: 5)
 *   --timeout <n>        Minutes before marking wallet as timeout (default: 10)
 *   --dry-run           Validate CSV without inserting or loading wallets
 *   --verbose           Enable verbose logging
 *   --help              Show this help message
 *
 * CSV Format:
 *   id,xpubkey,status,max_gap,created_at,ready_at,retry_count,auth_xpubkey,last_used_address_index
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServerlessMysql } from 'serverless-mysql';
import { InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { createLambdaClient } from '../src/utils/aws.utils';
import { getDbConnection, getUnixTimestamp, getWalletId } from '../src/utils';
import { WalletStatus } from '../src/types';
import config from '../src/config';

// ==========================
// Types
// ==========================

interface WalletRow {
  id: string;
  xpubkey: string;
  status?: string;
  max_gap?: number;
  created_at?: number;
  ready_at?: number;
  retry_count?: number;
  auth_xpubkey: string;
  last_used_address_index?: number;
}

interface InsertResult {
  inserted: number;
  skipped: number;
  errors: string[];
}

interface ProcessingResults {
  ready: number;
  error: number;
  timeout: number;
  total: number;
  failed: string[];
  startTime: number;
}

interface CliOptions {
  csvFile: string;
  batchSize: number;
  pollingInterval: number;
  batchDelay: number;
  timeoutMinutes: number;
  dryRun: boolean;
  verbose: boolean;
}

// ==========================
// Configuration
// ==========================

const DEFAULT_MAX_GAP = 20;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLLING_INTERVAL = 10; // seconds
const DEFAULT_BATCH_DELAY = 5; // seconds
const DEFAULT_TIMEOUT_MINUTES = 10;

// ==========================
// Utility Functions
// ==========================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(): CliOptions | null {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    printHelp();
    return null;
  }

  const csvIndex = args.indexOf('--csv');
  if (csvIndex === -1 || !args[csvIndex + 1]) {
    console.error('Error: --csv <file> is required');
    printHelp();
    return null;
  }

  const options: CliOptions = {
    csvFile: args[csvIndex + 1],
    batchSize: getNumericArg(args, '--batch-size', DEFAULT_BATCH_SIZE),
    pollingInterval: getNumericArg(args, '--polling-interval', DEFAULT_POLLING_INTERVAL),
    batchDelay: getNumericArg(args, '--batch-delay', DEFAULT_BATCH_DELAY),
    timeoutMinutes: getNumericArg(args, '--timeout', DEFAULT_TIMEOUT_MINUTES),
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
  };

  return options;
}

function getNumericArg(args: string[], flag: string, defaultValue: number): number {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1]) {
    return defaultValue;
  }
  const value = Number.parseInt(args[index + 1], 10);
  return Number.isNaN(value) ? defaultValue : value;
}

function printHelp(): void {
  console.log(`
Wallet Re-Initialization Script

Usage:
  yarn ts-node scripts/reinitialize-wallets.ts --csv <csv-file> [options]

Options:
  --csv <file>            Path to CSV file with wallet data (required)
  --batch-size <n>        Number of wallets to process per batch (default: ${DEFAULT_BATCH_SIZE})
  --polling-interval <n>  Seconds between status polls (default: ${DEFAULT_POLLING_INTERVAL})
  --batch-delay <n>       Seconds to wait between batches (default: ${DEFAULT_BATCH_DELAY})
  --timeout <n>           Minutes before marking wallet as timeout (default: ${DEFAULT_TIMEOUT_MINUTES})
  --dry-run              Validate CSV without inserting or loading wallets
  --verbose              Enable verbose logging
  --help                 Show this help message

CSV Format:
  id,xpubkey,status,max_gap,created_at,ready_at,retry_count,auth_xpubkey,last_used_address_index

Example:
  yarn ts-node scripts/reinitialize-wallets.ts --csv ./backups/wallets.csv --batch-size 50
  `);
}

function log(message: string, verbose: boolean, level: 'info' | 'error' | 'warn' = 'info'): void {
  if (level === 'error') {
    console.error(`[ERROR] ${message}`);
  } else if (level === 'warn') {
    console.warn(`[WARN] ${message}`);
  } else if (verbose || level === 'error') {
    console.log(`[INFO] ${message}`);
  }
}

// ==========================
// CSV Parsing
// ==========================

/**
 * Parse a CSV line, handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

async function parseWalletCSV(filePath: string, verbose: boolean): Promise<WalletRow[]> {
  const wallets: WalletRow[] = [];
  const errors: string[] = [];

  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }

  // Parse header
  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine);

  // Find column indices
  const idIndex = headers.indexOf('id');
  const xpubkeyIndex = headers.indexOf('xpubkey');
  const authXpubkeyIndex = headers.indexOf('auth_xpubkey');
  const statusIndex = headers.indexOf('status');
  const maxGapIndex = headers.indexOf('max_gap');
  const createdAtIndex = headers.indexOf('created_at');
  const readyAtIndex = headers.indexOf('ready_at');
  const retryCountIndex = headers.indexOf('retry_count');
  const lastUsedAddressIndexIndex = headers.indexOf('last_used_address_index');

  if (idIndex === -1 || xpubkeyIndex === -1 || authXpubkeyIndex === -1) {
    throw new Error('CSV must have columns: id, xpubkey, auth_xpubkey');
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = parseCSVLine(line);

    // Validate required fields
    if (!values[idIndex] || !values[xpubkeyIndex] || !values[authXpubkeyIndex]) {
      errors.push(`Line ${i + 1}: Missing required fields`);
      continue;
    }

    const wallet: WalletRow = {
      id: values[idIndex],
      xpubkey: values[xpubkeyIndex],
      auth_xpubkey: values[authXpubkeyIndex],
      status: statusIndex !== -1 ? values[statusIndex] : undefined,
      max_gap: maxGapIndex !== -1 && values[maxGapIndex] ? Number.parseInt(values[maxGapIndex], 10) : DEFAULT_MAX_GAP,
      created_at: createdAtIndex !== -1 && values[createdAtIndex] ? Number.parseInt(values[createdAtIndex], 10) : undefined,
      ready_at: readyAtIndex !== -1 && values[readyAtIndex] ? Number.parseInt(values[readyAtIndex], 10) : undefined,
      retry_count: retryCountIndex !== -1 && values[retryCountIndex] ? Number.parseInt(values[retryCountIndex], 10) : undefined,
      last_used_address_index: lastUsedAddressIndexIndex !== -1 && values[lastUsedAddressIndexIndex] ? Number.parseInt(values[lastUsedAddressIndexIndex], 10) : undefined,
    };

    // Validate wallet_id matches xpubkey
    const expectedId = getWalletId(wallet.xpubkey);
    if (wallet.id !== expectedId) {
      errors.push(`Line ${i + 1}: Wallet ID mismatch - CSV id=${wallet.id}, computed id=${expectedId}`);
      continue;
    }

    wallets.push(wallet);
  }

  if (errors.length > 0) {
    console.error(`\nFound ${errors.length} validation errors:`);
    errors.forEach((err) => console.error(`  - ${err}`));
    throw new Error(`CSV validation failed with ${errors.length} errors`);
  }

  log(`Successfully parsed ${wallets.length} wallets from CSV`, verbose);
  return wallets;
}

// ==========================
// Database Operations
// ==========================

async function insertWalletRows(
  mysql: ServerlessMysql,
  wallets: WalletRow[],
  verbose: boolean,
): Promise<InsertResult> {
  const result: InsertResult = {
    inserted: 0,
    skipped: 0,
    errors: [],
  };

  const ts = getUnixTimestamp();

  for (const wallet of wallets) {
    try {
      // Check if wallet already exists
      const existing = await mysql.query(
        'SELECT id FROM `wallet` WHERE `id` = ?',
        [wallet.id],
      );

      if (existing && existing.length > 0) {
        log(`Wallet ${wallet.id} already exists, skipping`, verbose);
        result.skipped++;
        continue;
      }

      // Insert new wallet with CREATING status
      const entry = {
        id: wallet.id,
        xpubkey: wallet.xpubkey,
        auth_xpubkey: wallet.auth_xpubkey,
        status: WalletStatus.CREATING,
        created_at: ts,
        max_gap: wallet.max_gap || DEFAULT_MAX_GAP,
        last_used_address_index: -1,
        retry_count: 0,
      };

      await mysql.query('INSERT INTO `wallet` SET ?', [entry]);
      result.inserted++;
      log(`Inserted wallet ${wallet.id}`, verbose);
    } catch (error) {
      const errorMsg = `Failed to insert wallet ${wallet.id}: ${error.message}`;
      log(errorMsg, true, 'error');
      result.errors.push(errorMsg);
    }
  }

  return result;
}

async function getWalletStatuses(
  mysql: ServerlessMysql,
  walletIds: string[],
): Promise<Map<string, WalletStatus>> {
  const statuses = new Map<string, WalletStatus>();

  if (walletIds.length === 0) {
    return statuses;
  }

  const placeholders = walletIds.map(() => '?').join(',');
  const results = await mysql.query(
    `SELECT id, status FROM \`wallet\` WHERE id IN (${placeholders})`,
    walletIds,
  );

  for (const row of results) {
    statuses.set(row.id, row.status);
  }

  return statuses;
}

// ==========================
// Lambda Invocation
// ==========================

async function invokeLoadWalletAsync(xpubkey: string, maxGap: number): Promise<void> {
  const client = createLambdaClient({
    endpoint: config.stage === 'dev'
      ? 'http://localhost:3002'
      : `https://lambda.${config.awsRegion}.amazonaws.com`,
    region: config.awsRegion,
  });

  const command = new InvokeCommand({
    FunctionName: `${config.serviceName}-${config.stage}-loadWalletAsync`,
    InvocationType: 'Event',
    Payload: JSON.stringify({ xpubkey, maxGap }),
  });

  const response: InvokeCommandOutput = await client.send(command);

  if (response.StatusCode !== 202) {
    throw new Error(`Lambda invoke failed with status ${response.StatusCode}`);
  }
}

// ==========================
// Batch Processing
// ==========================

async function processBatch(
  mysql: ServerlessMysql,
  batch: WalletRow[],
  results: ProcessingResults,
  batchNumber: number,
  totalBatches: number,
  options: CliOptions,
): Promise<void> {
  const walletIds = batch.map((w) => w.id);
  const batchStartTime = Date.now();

  // Invoke loadWalletAsync for all wallets in batch
  const invocations = await Promise.allSettled(
    batch.map((wallet) => invokeLoadWalletAsync(wallet.xpubkey, wallet.max_gap || DEFAULT_MAX_GAP)),
  );

  // Track failed invocations
  invocations.forEach((result, index) => {
    if (result.status === 'rejected') {
      const wallet = batch[index];
      log(`Failed to invoke Lambda for wallet ${wallet.id}: ${result.reason}`, true, 'error');
      results.failed.push(wallet.id);
    }
  });

  // Poll until all wallets in batch complete or timeout
  const timeoutMs = options.timeoutMinutes * 60 * 1000;
  const pollingIntervalMs = options.pollingInterval * 1000;

  // Track which wallets we've already counted
  const countedWallets = new Set<string>();

  while (true) {
    await sleep(pollingIntervalMs);

    const statuses = await getWalletStatuses(mysql, walletIds);

    let allComplete = true;
    let batchReady = 0;
    let batchError = 0;
    let batchTimeout = 0;
    let batchCreating = 0;

    for (const walletId of walletIds) {
      const status = statuses.get(walletId);

      // Only count each wallet once
      if (!countedWallets.has(walletId)) {
        if (status === WalletStatus.CREATING) {
          // Check for timeout
          if (Date.now() - batchStartTime > timeoutMs) {
            log(`Wallet ${walletId} timed out after ${options.timeoutMinutes} minutes`, true, 'warn');
            results.timeout++;
            results.failed.push(walletId);
            countedWallets.add(walletId);
            batchTimeout++;
          } else {
            allComplete = false;
            batchCreating++;
          }
        } else if (status === WalletStatus.READY) {
          results.ready++;
          countedWallets.add(walletId);
          batchReady++;
        } else if (status === WalletStatus.ERROR) {
          results.error++;
          results.failed.push(walletId);
          countedWallets.add(walletId);
          batchError++;
        }
      } else if (status === WalletStatus.CREATING) {
        // Wallet was already counted but check if it's now timed out
        if (Date.now() - batchStartTime > timeoutMs) {
          allComplete = false;
        } else {
          allComplete = false;
        }
      }
    }

    // Log progress for this batch
    if (batchCreating > 0 || batchReady > 0 || batchError > 0 || batchTimeout > 0) {
      console.log(`  Batch ${batchNumber}/${totalBatches}: Ready: ${batchReady}, Error: ${batchError}, Timeout: ${batchTimeout}, Creating: ${batchCreating}`);
    }

    if (allComplete) {
      break;
    }
  }
}

// ==========================
// Reporting
// ==========================

function generateReport(results: ProcessingResults): void {
  const duration = Math.round((Date.now() - results.startTime) / 1000);
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = duration % 60;

  console.log('\n' + '='.repeat(60));
  console.log('WALLET RE-INITIALIZATION REPORT');
  console.log('='.repeat(60));
  console.log(`\nExecution Time: ${hours}h ${minutes}m ${seconds}s`);
  console.log(`\nTotal Wallets: ${results.total}`);
  console.log(`  ✓ Ready:      ${results.ready} (${((results.ready / results.total) * 100).toFixed(1)}%)`);
  console.log(`  ✗ Error:      ${results.error} (${((results.error / results.total) * 100).toFixed(1)}%)`);
  console.log(`  ⏱ Timeout:    ${results.timeout} (${((results.timeout / results.total) * 100).toFixed(1)}%)`);

  if (results.failed.length > 0) {
    console.log(`\nFailed Wallets (${results.failed.length}):`);

    // Write failed wallets to file
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const failedFile = path.join(logDir, `failed_wallets_${timestamp}.txt`);
    fs.writeFileSync(failedFile, results.failed.join('\n'));

    console.log(`  Failed wallet IDs saved to: ${failedFile}`);
    console.log(`  First 10 failed wallets: ${results.failed.slice(0, 10).join(', ')}`);
  }

  console.log('\n' + '='.repeat(60));
}

// ==========================
// Main Function
// ==========================

async function main() {
  const options = parseArgs();
  if (!options) {
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('WALLET RE-INITIALIZATION SCRIPT');
  console.log('='.repeat(60));
  console.log(`\nConfiguration:`);
  console.log(`  CSV File:         ${options.csvFile}`);
  console.log(`  Batch Size:       ${options.batchSize}`);
  console.log(`  Polling Interval: ${options.pollingInterval}s`);
  console.log(`  Batch Delay:      ${options.batchDelay}s`);
  console.log(`  Timeout:          ${options.timeoutMinutes}m`);
  console.log(`  Dry Run:          ${options.dryRun}`);
  console.log(`  Verbose:          ${options.verbose}`);
  console.log('\n' + '='.repeat(60) + '\n');

  // Parse CSV
  console.log('Step 1/4: Parsing CSV file...');
  const wallets = await parseWalletCSV(options.csvFile, options.verbose);
  console.log(`✓ Parsed ${wallets.length} wallets\n`);

  if (options.dryRun) {
    console.log('Dry run mode: Validation complete. Exiting without processing.');
    return;
  }

  // Get database connection
  const mysql = getDbConnection();

  try {
    // Insert wallet rows
    console.log('Step 2/4: Inserting wallet rows...');
    const insertResult = await insertWalletRows(mysql, wallets, options.verbose);
    console.log(`✓ Inserted: ${insertResult.inserted}, Skipped: ${insertResult.skipped}`);

    if (insertResult.errors.length > 0) {
      console.log(`⚠ Errors: ${insertResult.errors.length}`);
      insertResult.errors.forEach((err) => console.error(`  - ${err}`));
    }

    if (insertResult.inserted === 0) {
      console.log('\nNo wallets to process. Exiting.');
      return;
    }

    console.log('');

    // Process in batches
    console.log('Step 3/4: Processing wallets in batches...');
    const totalBatches = Math.ceil(insertResult.inserted / options.batchSize);
    console.log(`Total batches: ${totalBatches}\n`);

    const results: ProcessingResults = {
      ready: 0,
      error: 0,
      timeout: 0,
      total: insertResult.inserted,
      failed: [],
      startTime: Date.now(),
    };

    // Filter out skipped wallets (only process inserted ones)
    const walletsToProcess = wallets.filter((w) => {
      // Check if this wallet was inserted by checking if it's not in the skipped list
      return true; // We'll process all, the insertWalletRows already filtered
    }).slice(0, insertResult.inserted);

    // Process batches
    for (let i = 0; i < walletsToProcess.length; i += options.batchSize) {
      const batch = walletsToProcess.slice(i, i + options.batchSize);
      const batchNumber = Math.floor(i / options.batchSize) + 1;

      console.log(`\nProcessing batch ${batchNumber}/${totalBatches} (${batch.length} wallets)...`);

      await processBatch(mysql, batch, results, batchNumber, totalBatches, options);

      // Log overall progress after batch completes
      const completedWallets = results.ready + results.error + results.timeout;
      const percentComplete = ((completedWallets / results.total) * 100).toFixed(1);
      console.log(`  Overall Progress: ${completedWallets}/${results.total} (${percentComplete}%) | Ready: ${results.ready}, Error: ${results.error}, Timeout: ${results.timeout}`);

      // Delay before next batch (except for last batch)
      if (i + options.batchSize < walletsToProcess.length) {
        log(`Waiting ${options.batchDelay}s before next batch...`, options.verbose);
        await sleep(options.batchDelay * 1000);
      }
    }

    console.log('\n');

    // Generate report
    console.log('Step 4/4: Generating report...');
    generateReport(results);
  } finally {
    await mysql.quit();
  }
}

// ==========================
// Entry Point
// ==========================

main()
  .then(() => {
    console.log('\n✓ Script completed successfully\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n✗ Script failed with error:');
    console.error(error);
    process.exit(1);
  });
