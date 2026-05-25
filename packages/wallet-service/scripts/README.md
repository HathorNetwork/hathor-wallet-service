# Wallet Re-Initialization Script

This directory contains operational scripts for the wallet-service.

## reinitialize-wallets.ts

Script to re-initialize wallets from a CSV export after a database reset.

### Prerequisites

No additional dependencies required - the script uses only Node.js built-in modules.

### Usage

```bash
# Validate CSV file (dry run)
yarn ts-node scripts/reinitialize-wallets.ts \
  --csv ./backups/wallets.csv \
  --dry-run

# Run re-initialization with default settings
yarn ts-node scripts/reinitialize-wallets.ts \
  --csv ./backups/wallets.csv

# Run with custom settings
yarn ts-node scripts/reinitialize-wallets.ts \
  --csv ./backups/wallets.csv \
  --batch-size 50 \
  --polling-interval 10 \
  --batch-delay 5 \
  --timeout 10 \
  --verbose
```

### Options

- `--csv <file>` - Path to CSV file with wallet data (required)
- `--batch-size <n>` - Number of wallets to process per batch (default: 50)
- `--polling-interval <n>` - Seconds between status polls (default: 10)
- `--batch-delay <n>` - Seconds to wait between batches (default: 5)
- `--timeout <n>` - Minutes before marking wallet as timeout (default: 10)
- `--dry-run` - Validate CSV without inserting or loading wallets
- `--verbose` - Enable verbose logging
- `--help` - Show help message

### CSV Format

The CSV file should have the following columns:

```
id,xpubkey,status,max_gap,created_at,ready_at,retry_count,auth_xpubkey,last_used_address_index
```

Required columns:
- `id` - Wallet ID (must match SHA256d hash of xpubkey)
- `xpubkey` - Wallet's extended public key
- `auth_xpubkey` - Authentication extended public key

Optional columns (defaults will be used if missing):
- `status` - Wallet status (will be reset to 'creating')
- `max_gap` - Maximum address gap (default: 20)
- `created_at` - Creation timestamp (will use current time)
- `ready_at` - Ready timestamp
- `retry_count` - Retry count (will be reset to 0)
- `last_used_address_index` - Last used address index

### Environment Variables

The script uses the same environment variables as the wallet-service:

- `DB_ENDPOINT` - Database host
- `DB_NAME` - Database name
- `DB_USER` - Database user
- `DB_PASS` - Database password
- `DB_PORT` - Database port
- `AWS_REGION` - AWS region
- `STAGE` - Stage name (dev/production)
- `SERVICE_NAME` - Service name

### Output

The script will:

1. Parse and validate the CSV file
2. Insert wallet rows into the database (skipping existing wallets)
3. Process wallets in batches, invoking Lambda functions
4. Monitor progress with console logging
5. Generate a final report with statistics

Logs and failed wallet lists are saved to `./logs/` directory.

### Example Output

```
============================================================
WALLET RE-INITIALIZATION SCRIPT
============================================================

Configuration:
  CSV File:         ./backups/wallets.csv
  Batch Size:       50
  Polling Interval: 10s
  Batch Delay:      5s
  Timeout:          10m
  Dry Run:          false
  Verbose:          false

============================================================

Step 1/4: Parsing CSV file...
✓ Parsed 15000 wallets

Step 2/4: Inserting wallet rows...
✓ Inserted: 15000, Skipped: 0

Step 3/4: Processing wallets in batches...
Total batches: 300

Processing batch 1/300 (50 wallets)...
  Batch 1/300: Ready: 45, Error: 5, Timeout: 0, Creating: 0
  Overall Progress: 50/15000 (0.3%) | Ready: 45, Error: 5, Timeout: 0

Processing batch 2/300 (50 wallets)...
  Batch 2/300: Ready: 48, Error: 2, Timeout: 0, Creating: 0
  Overall Progress: 100/15000 (0.7%) | Ready: 93, Error: 7, Timeout: 0

...

Processing batch 300/300 (50 wallets)...
  Batch 300/300: Ready: 49, Error: 1, Timeout: 0, Creating: 0
  Overall Progress: 15000/15000 (100.0%) | Ready: 14950, Error: 50, Timeout: 0

Step 4/4: Generating report...

============================================================
WALLET RE-INITIALIZATION REPORT
============================================================

Execution Time: 32h 15m 42s

Total Wallets: 15000
  ✓ Ready:      14950 (99.7%)
  ✗ Error:      50 (0.3%)
  ⏱ Timeout:    0 (0.0%)

Failed Wallets (50):
  Failed wallet IDs saved to: logs/failed_wallets_2025-01-04T12-30-45.txt
  First 10 failed wallets: abc123..., def456..., ...

============================================================

✓ Script completed successfully
```

### Error Handling

- The script is idempotent - you can safely re-run it
- Existing wallets are skipped automatically
- Failed wallets are logged to `./logs/failed_wallets_<timestamp>.txt`
- The script continues processing even if some wallets fail
- Use the failed wallets file to retry only failed wallets:

```bash
yarn ts-node scripts/reinitialize-wallets.ts \
  --csv ./logs/failed_wallets_2025-01-04T12-30-45.txt \
  --batch-size 10
```

### Performance Considerations

**For 15,000 wallets:**
- Batch size: 50 (recommended)
- Total batches: 300
- Time per batch: ~5-10 minutes
- **Total time: 25-50 hours**

**Batch Size Tuning:**
- Smaller batches (20-30): Safer but slower
- Larger batches (100+): Faster but may hit Lambda concurrency limits
- Monitor Lambda metrics and adjust accordingly

### Troubleshooting

**High error rate:**
- Ensure daemon is fully synced before running
- Check Lambda CloudWatch logs for specific errors
- Verify database connectivity

**Script hangs:**
- Press Ctrl+C to stop (safe - idempotent)
- Check database for wallets stuck in 'creating' status
- Restart script - it will skip already-processed wallets

**Database connection errors:**
- Reduce batch size
- Check database connection pool limits
- Ensure only one script instance is running

### Documentation

For the complete guide including SOP and troubleshooting, see:
- [Database Reset & Re-Initialization Guide](../../../docs/database-reset-and-wallet-reinitialization.md)
