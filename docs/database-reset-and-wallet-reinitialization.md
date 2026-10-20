# Wallet Service Database Reset & Re-Initialization Guide

## Overview

This guide covers the process for resetting the wallet-service database and re-initializing all wallets from a CSV export. The approach leverages the existing wallet loading infrastructure to regenerate all derived data.

---

## Architecture

### Data Categories

**Preserved Data (exported/imported):**

- `wallet` table metadata

**Regenerated Data (via existing load process):**

- `address` - Derived from xpubkeys
- `wallet_balance` - Aggregated from address_balance
- `wallet_tx_history` - Aggregated from address_tx_history

**Blockchain Data (synced by daemon):**

- `transaction`, `tx_output`, `address_balance`, `address_tx_history`
- Must be resynced by daemon before wallet loading

---

## Prerequisites

### Before Database Reset

1. **Export wallet data to CSV:**

```sql
SELECT
  id,
  xpubkey,
  status,
  max_gap,
  created_at,
  ready_at,
  retry_count,
  auth_xpubkey,
  last_used_address_index
FROM wallet
INTO OUTFILE '/tmp/wallets_backup.csv'
FIELDS TERMINATED BY ','
ENCLOSED BY '"'
LINES TERMINATED BY '\n';
```

Or via mysqldump:

```bash
mysqldump -u user -p database wallet --tab=/tmp --fields-terminated-by=','
```

2. **Verify CSV export:**

```bash
wc -l /tmp/wallets_backup.csv  # Should match wallet count
head -5 /tmp/wallets_backup.csv # Verify format
```

### After Database Reset

1. **Run schema migrations:**

```bash
cd packages/wallet-service
yarn sequelize-cli db:migrate
```

2. **Ensure daemon is syncing:**

- Daemon must populate `transaction`, `tx_output`, `address_balance`, `address_tx_history`
- Wait until daemon is caught up before starting wallet re-initialization
- Check sync_metadata table for last_event_id

---

## Re-Initialization Script Design

### Script: `scripts/reinitialize-wallets.ts`

**Purpose:** Batch-process wallet re-initialization from CSV export

**Input:** CSV file with columns: `id,xpubkey,status,max_gap,created_at,ready_at,retry_count,auth_xpubkey,last_used_address_index`

**Processing Strategy:**

1. Parse CSV and validate required fields
2. Insert wallet rows (status='creating', retry_count=0)
3. Process in batches of 50 wallets
4. For each batch:
   - Invoke loadWalletAsync for all wallets in batch
   - Poll until batch completes (all wallets READY or ERROR)
   - Wait 5s before starting next batch
5. Generate final report

### Key Design Elements

**Batch Configuration:**

- **Batch size:** 50 wallets (configurable via CLI arg)
- **Polling interval:** 10 seconds
- **Batch delay:** 5 seconds between batches
- **Timeout:** 10 minutes per wallet (fail if still CREATING)

**Concurrency Control:**

```
Total: 15,000 wallets
Batch size: 50
Batches: 300
Time estimate: ~5-10 minutes per batch = 25-50 hours total
```

**Progress Tracking:**

- Console-based progress logging
- Status counts: READY / ERROR / CREATING / TIMEOUT
- Per-batch and overall statistics
- Per-batch timing

**Error Handling:**

- Skip existing wallets (idempotent)
- Log failed insertions
- Log failed Lambda invocations
- Continue on errors
- Generate comprehensive error report

---

## Script Implementation Outline

### Dependencies

No external dependencies required - the script uses only Node.js built-in modules (`fs`, `path`).

### Core Functions

**1. parseWalletCSV(filePath: string): Promise<WalletRow[]>**

- Reads CSV file
- Validates: id, xpubkey, auth_xpubkey present
- Returns array of wallet objects

**2. insertWalletRows(wallets: WalletRow[]): Promise<InsertResult>**

- Batch INSERT with ON DUPLICATE KEY skip
- Uses current timestamp for created_at
- Sets status='creating', retry_count=0
- Returns: { inserted: number, skipped: number }

**3. processBatch(wallets: WalletRow[], batchSize: number): Promise<void>**

- Splits wallets into batches
- For each batch:
  - Invokes loadWalletAsync for all wallets
  - Polls status until batch complete
  - Updates progress bar

**4. invokeLoadWalletAsync(xpubkey: string, maxGap: number): Promise<void>**

- Reuses existing function from wallet.ts
- Invokes Lambda with Event invocation type

**5. pollWalletStatus(walletIds: string[]): Promise<StatusMap>**

- Queries wallet table for current status
- Returns map: { walletId → status }

**6. generateReport(results: ProcessingResults): void**

- Summary: Total / READY / ERROR / TIMEOUT / SKIPPED
- Error details: List of failed wallet IDs
- Execution time

### Script Flow

```typescript
async function main() {
  // 1. Parse CSV
  const wallets = await parseWalletCSV(CSV_FILE_PATH);
  console.log(`Parsed ${wallets.length} wallets from CSV`);

  // 2. Insert wallet rows
  const { inserted, skipped } = await insertWalletRows(wallets);
  console.log(`Inserted: ${inserted}, Skipped: ${skipped}`);

  // 3. Process in batches
  const results = {
    ready: 0,
    error: 0,
    timeout: 0,
    total: inserted,
  };

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    console.log(`Processing batch ${batchNum}/${totalBatches}...`);

    // Invoke all wallets in batch
    await Promise.allSettled(
      batch.map((w) => invokeLoadWalletAsync(w.xpubkey, w.max_gap)),
    );

    // Poll until batch completes
    const walletIds = batch.map((w) => w.id);
    await pollUntilComplete(walletIds, results);

    // Log progress
    const completed = results.ready + results.error + results.timeout;
    console.log(`Overall Progress: ${completed}/${results.total}`);

    // Delay before next batch
    await sleep(5000);
  }

  // 4. Generate report
  generateReport(results);
}
```

---

## Standard Operating Procedure (SOP)

### Phase 1: Pre-Reset

**1.1. Export wallet data**

```bash
# Connect to production database
mysql -h <host> -u <user> -p <database>

# Export wallets
SELECT id, xpubkey, status, max_gap, created_at, ready_at,
       retry_count, auth_xpubkey, last_used_address_index
FROM wallet
INTO OUTFILE '/tmp/wallets_backup.csv'
FIELDS TERMINATED BY ',' ENCLOSED BY '"' LINES TERMINATED BY '\n';
```

**1.2. Backup CSV to secure location**

```bash
# Copy from database server
scp user@db-host:/tmp/wallets_backup.csv ./backups/wallets_$(date +%Y%m%d).csv

# Verify
wc -l ./backups/wallets_*.csv
```

**1.3. Document database state**

```sql
-- Record counts for verification
SELECT COUNT(*) FROM wallet;           -- Should match CSV lines
SELECT COUNT(*) FROM address;
SELECT COUNT(*) FROM wallet_balance;
SELECT COUNT(*) FROM wallet_tx_history;
```

### Phase 2: Database Reset

**2.1. Stop wallet-service**

```bash
# Disable APIs (prevent new wallet operations)
# Method depends on deployment (Lambda: remove API Gateway triggers, etc.)
```

**2.2. Reset database schema**

```bash
# Drop and recreate database
mysql -h <host> -u <user> -p <<EOF
DROP DATABASE wallet_service;
CREATE DATABASE wallet_service;
EOF

# Run migrations
cd packages/wallet-service
yarn sequelize-cli db:migrate
```

**2.3. Verify schema**

```bash
mysql -h <host> -u <user> -p -e "SHOW TABLES" wallet_service
# Should show all tables with 0 rows
```

### Phase 3: Daemon Resync

**3.1. Start daemon (or wait for existing daemon)**

```bash
# Daemon will repopulate:
# - transaction
# - tx_output
# - address_balance
# - address_tx_history
```

**3.2. Monitor daemon progress**

```sql
-- Check sync_metadata
SELECT * FROM sync_metadata;

-- Check data population
SELECT COUNT(*) FROM transaction;
SELECT COUNT(*) FROM tx_output;
SELECT COUNT(*) FROM address_balance;
```

**3.3. Wait for sync completion**

- Monitor until last_event_id matches current blockchain height
- Typical time: 6-24 hours depending on blockchain size

### Phase 4: Wallet Re-Initialization

**4.1. Prepare environment**

```bash
# Set environment variables
export AWS_REGION=us-east-1
export DB_ENDPOINT=<host>
export DB_NAME=wallet_service
export DB_USER=<user>
export DB_PASS=<pass>
export STAGE=production
export SERVICE_NAME=wallet-service
```

**4.2. Run re-initialization script**

```bash
cd packages/wallet-service

# Dry run (validate CSV only)
yarn ts-node scripts/reinitialize-wallets.ts \
  --csv ./backups/wallets_20250104.csv \
  --dry-run

# Execute re-initialization
yarn ts-node scripts/reinitialize-wallets.ts \
  --csv ./backups/wallets_20250104.csv \
  --batch-size 50 \
  --verbose
```

**4.3. Monitor progress**

- Script displays real-time progress bar
- Logs saved to `./logs/reinit_$(date).log`
- Estimated time: 25-50 hours for 15,000 wallets

**4.4. Handle errors**

- Script continues on errors
- Failed wallets logged to `./logs/failed_wallets.txt`
- Retry failed wallets after investigation:

```bash
yarn ts-node scripts/reinitialize-wallets.ts \
  --csv ./logs/failed_wallets.txt \
  --batch-size 10
```

### Phase 5: Verification

**5.1. Verify wallet counts**

```sql
-- Compare with pre-reset counts
SELECT COUNT(*) FROM wallet WHERE status = 'ready';
SELECT COUNT(*) FROM wallet WHERE status = 'error';
SELECT COUNT(*) FROM address;
SELECT COUNT(*) FROM wallet_balance;
SELECT COUNT(*) FROM wallet_tx_history;
```

**5.2. Review error wallets**

```sql
-- List wallets in ERROR state
SELECT id, xpubkey, retry_count, ready_at
FROM wallet
WHERE status = 'error';

-- Investigate errors in CloudWatch logs
```

### Phase 6: Post-Reset

**6.1. Document results**

- Total wallets processed
- Success rate (READY count)
- Error count and reasons
- Execution time

**6.2. Monitor production**

- Watch CloudWatch metrics for anomalies
- Check error rates in API calls
- Verify user reports

---

## Troubleshooting

### Issue: High ERROR Rate

**Symptom:** Many wallets fail to load (status=ERROR)

**Causes:**

- Daemon not fully synced
- Missing address_balance or address_tx_history data
- Lambda timeout (600s)
- Database connection issues

**Solution:**

1. Verify daemon sync completion
2. Check CloudWatch logs for specific errors
3. Increase Lambda timeout if needed
4. Retry failed wallets with smaller batch size

### Issue: Script Hangs on Batch

**Symptom:** Progress bar stops, no status updates

**Causes:**

- Wallets stuck in CREATING status
- Database connection lost
- Lambda invocation failures

**Solution:**

1. Check wallet status directly: `SELECT * FROM wallet WHERE status='creating' LIMIT 10;`
2. Kill script (Ctrl+C) - it's idempotent
3. Investigate stuck wallets in CloudWatch
4. Restart script - will skip already-loaded wallets

### Issue: Database Connection Errors

**Symptom:** "Too many connections" or timeout errors

**Causes:**

- Connection pool exhausted
- Long-running queries
- Multiple script instances

**Solution:**

1. Reduce batch size
2. Increase connection pool size in RDS
3. Ensure only one script instance running
4. Add connection retry logic

---

## Performance Tuning

### Optimize Batch Size

**Small batches (20-30):**

- Pros: Easier to monitor, less Lambda concurrency
- Cons: Slower overall (more overhead)

**Large batches (100+):**

- Pros: Faster overall completion
- Cons: Risk of Lambda throttling, harder to track progress

**Recommended:** Start with 50, adjust based on Lambda metrics

---

## Security Considerations

1. **Database credentials:** Use AWS Secrets Manager or environment variables
1. **Lambda permissions:** Script needs `lambda:InvokeFunction` permission
1. **Audit logging:** Script logs all operations for audit trail

---

## Rollback Plan

If re-initialization fails catastrophically:

1. **Stop script:** Ctrl+C (idempotent, safe to stop anytime)
2. **Assess damage:** Check database state
3. **Options:**
   - Reset DB again and retry with fixes
   - Restore from full database backup (if available)
   - Continue from checkpoint (script skips completed wallets)

---
