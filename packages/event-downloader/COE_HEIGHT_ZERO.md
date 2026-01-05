# COE: Transactions Stored with height = 0 in Wallet Service Database

## Summary

Over 1.4 million transactions in the wallet-service database have `height = 0` instead of the correct block height or `NULL`. In the wallet-service architecture, the `height` field on a transaction represents the height of the block that confirmed it. Unconfirmed transactions should have `height = NULL`, and confirmed transactions should have the height of their confirming block.

The sync-daemon is responsible for processing fullnode events via WebSocket and updating the database accordingly. Investigation revealed two bugs:

1. The fullnode sends `metadata.height = 0` for transactions even when they have a `first_block` (confirming block), and the daemon blindly trusts this value.
2. When a transaction loses its confirmation (`first_block` goes back to `null`), the daemon ignores the event entirely and never resets the height to `NULL`.

**Discovery**: Manual database audit on 2025-12-31.

**Root Causes**:
1. The fullnode sends `height: 0` in `VERTEX_METADATA_CHANGED` events even when `first_block` is populated. The daemon's `handleTxFirstBlock` function uses this value directly without validation.
2. The daemon's `metadataDiff` function has no handling for when `first_block` changes from a block hash back to `null`. These events are ignored, leaving the height at `0` instead of resetting it to `NULL`.

## Impact

- **1,408,080 transactions** stored with incorrect `height = 0`
- Transaction versions affected:
  - Version 1 (regular transactions): 1,159,985
  - Version 2 (token creation): 248,091
  - Version 6 (nano contracts): 3
  - Version 0 (genesis block): 1 (expected)
- **Customer Impact**: APIs and queries that rely on transaction height for confirmation status may return incorrect data
- **Ongoing**: ~50-200 new transactions per day continue to be affected

## Timeline

- **Unknown**: Issue began occurring (likely since daemon deployment or fullnode update)
- **2025-12-31 ~15:00 UTC**: Anomaly discovered via database query showing 1.4M transactions with `height = 0`
- **2025-12-31 ~16:00 UTC**: Created `event-downloader` package to download all fullnode events for analysis
- **2025-12-31 ~19:00 UTC**: Downloaded all 7.8M events from fullnode
- **2025-12-31 ~20:00 UTC**: Identified root cause by analyzing events for sample transaction `000000b36b93b2e3088a63108882097c1dfc45e6303ec88ab34d99750029f871`

## Metrics

```sql
-- Total affected transactions
SELECT COUNT(*) FROM transaction WHERE height = 0;
-- Result: 1,408,080

-- Breakdown by version
SELECT version, COUNT(*) FROM transaction WHERE height = 0 GROUP BY version;
-- 0: 1 (genesis block - expected)
-- 1: 1,159,985
-- 2: 248,091
-- 6: 3

-- Daily rate of new affected transactions
SELECT DATE(FROM_UNIXTIME(timestamp)) as date, COUNT(*)
FROM transaction WHERE height = 0
GROUP BY date ORDER BY date DESC LIMIT 10;
```

## Investigation Details

### Background: Daemon Architecture

The sync-daemon connects to the fullnode via WebSocket and processes events:

1. `NEW_VERTEX_ACCEPTED`: A new transaction/block was added to the DAG
2. `VERTEX_METADATA_CHANGED`: Transaction metadata changed (e.g., got confirmed by a block)

When processing `NEW_VERTEX_ACCEPTED` for a transaction (`packages/daemon/src/services/index.ts:246-250`):

```typescript
let height: number | null = metadata.height;

if (!isBlock(version) && !metadata.first_block) {
  height = null;  // Unconfirmed tx gets NULL height
}
```

When a `VERTEX_METADATA_CHANGED` event indicates a transaction got its first confirmation, `handleTxFirstBlock` is called (`packages/daemon/src/services/index.ts:689`):

```typescript
const height: number | null = metadata.height;  // Blindly trusts fullnode
await addOrUpdateTx(mysql, hash, height, timestamp, version, weight);
```

### Event Analysis Tool

We created the `event-downloader` package to download all fullnode events and correlate them with transactions:

- Downloaded 7,835,577 events from mainnet fullnode
- Stored in SQLite with transaction hash indexing
- Enables querying all events that affected a specific transaction

### Sample Transaction Analysis

Transaction: `000000b36b93b2e3088a63108882097c1dfc45e6303ec88ab34d99750029f871`

Events in chronological order:

#### Event 7762975 - VERTEX_METADATA_CHANGED
```json
{
  "event": {
    "id": 7762975,
    "timestamp": 1766182695.3963125,
    "type": "VERTEX_METADATA_CHANGED",
    "data": {
      "hash": "000000b36b93b2e3088a63108882097c1dfc45e6303ec88ab34d99750029f871",
      "version": 1,
      "metadata": {
        "voided_by": [],
        "first_block": null,
        "height": 0
      }
    }
  }
}
```

#### Event 7762979 - NEW_VERTEX_ACCEPTED
```json
{
  "event": {
    "id": 7762979,
    "timestamp": 1766182695.5350096,
    "type": "NEW_VERTEX_ACCEPTED",
    "data": {
      "hash": "000000b36b93b2e3088a63108882097c1dfc45e6303ec88ab34d99750029f871",
      "version": 1,
      "metadata": {
        "voided_by": [],
        "first_block": null,
        "height": 0
      }
    }
  }
}
```
**Daemon behavior**: Sets `height = NULL` because `first_block` is null (correct).

#### Event 7762981 - VERTEX_METADATA_CHANGED (TX_FIRST_BLOCK)
```json
{
  "event": {
    "id": 7762981,
    "timestamp": 1766182710.9933312,
    "type": "VERTEX_METADATA_CHANGED",
    "data": {
      "hash": "000000b36b93b2e3088a63108882097c1dfc45e6303ec88ab34d99750029f871",
      "version": 1,
      "metadata": {
        "voided_by": [],
        "first_block": "000000000000000009800ba7eda9ee1734940d45dcfb568ac51d1426a290e761",
        "height": 0
      }
    }
  }
}
```
**Daemon behavior**: Detects `first_block` is now set, calls `handleTxFirstBlock`, stores `height = 0` (BUG - should be block's height).

#### Event 7762993 - VERTEX_METADATA_CHANGED
```json
{
  "event": {
    "id": 7762993,
    "timestamp": 1766184357.769475,
    "type": "VERTEX_METADATA_CHANGED",
    "data": {
      "hash": "000000b36b93b2e3088a63108882097c1dfc45e6303ec88ab34d99750029f871",
      "version": 1,
      "metadata": {
        "voided_by": [],
        "first_block": null,
        "height": 0
      }
    }
  }
}
```
**Note**: `first_block` returned to null because the transaction was sent back to the mempool.

#### Event 7763176 - VERTEX_METADATA_CHANGED
```json
{
  "event": {
    "id": 7763176,
    "timestamp": 1766185267.1527846,
    "type": "VERTEX_METADATA_CHANGED",
    "data": {
      "hash": "000000b36b93b2e3088a63108882097c1dfc45e6303ec88ab34d99750029f871",
      "version": 1,
      "metadata": {
        "voided_by": [],
        "first_block": "00000000000000000cf169d68d55d2c8f850a602623fa3dd54ff0bd332e9cbc3",
        "height": 0
      }
    }
  }
}
```
**Note**: Different `first_block`, still `height: 0`.

#### Event 7763190 - VERTEX_METADATA_CHANGED
```json
{
  "event": {
    "id": 7763190,
    "timestamp": 1766186968.6764472,
    "type": "VERTEX_METADATA_CHANGED",
    "data": {
      "hash": "000000b36b93b2e3088a63108882097c1dfc45e6303ec88ab34d99750029f871",
      "version": 1,
      "metadata": {
        "voided_by": [],
        "first_block": null,
        "height": 0
      }
    }
  }
}
```
**Daemon behavior**: `first_block` is null, but `metadataDiff` returns `IGNORE` because there's no handling for this case (BUG #2 - should reset height to `NULL`).

### Key Findings

1. The fullnode **always** sends `metadata.height = 0` for transactions, regardless of whether `first_block` is set. The `height` field in transaction metadata does not represent the confirming block's height.

2. The daemon's `metadataDiff` function only handles the case when `first_block` becomes set (`TX_FIRST_BLOCK`), but has no handling for when `first_block` becomes `null` again. This means transactions that lose their confirmation keep `height = 0` instead of being reset to `height = NULL`.

### Bug #2: Missing Handler for Lost Confirmation

The `metadataDiff` function at `packages/daemon/src/services/index.ts:150-169`:

```typescript
if (first_block
  && first_block.length
  && first_block.length > 0) {
  if (!dbTx.height) {
    return {
      type: METADATA_DIFF_EVENT_TYPES.TX_FIRST_BLOCK,
      originalEvent: event,
    };
  }

  return {
    type: METADATA_DIFF_EVENT_TYPES.IGNORE,
    originalEvent: event,
  };
}

return {
  type: METADATA_DIFF_EVENT_TYPES.IGNORE,  // <-- BUG: Should handle first_block becoming null
  originalEvent: event,
};
```

When `first_block` is `null`:
- The condition `if (first_block && first_block.length > 0)` is **FALSE**
- Falls through to return `IGNORE`
- No `TX_LOST_FIRST_BLOCK` event type exists

This means even if Bug #1 were fixed and the correct height was stored initially, transactions that get sent back to the mempool would retain their old height instead of being reset to `NULL`.

## Root Cause Analysis (5 Whys)

### Bug #1: Wrong height stored on confirmation

**Problem**: Transactions have `height = 0` instead of the correct block height when confirmed.

1. **Why do transactions have `height = 0`?**
   - The daemon's `handleTxFirstBlock` function stores `metadata.height` directly from the fullnode event.

2. **Why does `handleTxFirstBlock` store the wrong value?**
   - It assumes `metadata.height` contains the height of the confirming block when `first_block` is set.

3. **Why is that assumption wrong?**
   - The fullnode sends `metadata.height = 0` for transactions even when they have a `first_block`.

4. **Why does the fullnode send `height = 0` for confirmed transactions?**
   - The `height` field in transaction metadata represents something different.

5. **Why wasn't this validated?**
   - The daemon blindly trusts the fullnode data without validating that `height > 0` when `first_block` is present.

### Bug #2: Height not reset when transaction loses confirmation

**Problem**: Transactions that lose their confirmation (sent back to mempool) retain `height = 0` instead of being reset to `NULL`.

1. **Why do transactions keep `height = 0` when sent back to mempool?**
   - The daemon ignores `VERTEX_METADATA_CHANGED` events where `first_block` becomes `null`.

2. **Why does the daemon ignore these events?**
   - The `metadataDiff` function returns `IGNORE` when `first_block` is null.

3. **Why does `metadataDiff` ignore null `first_block`?**
   - It only handles the case when `first_block` becomes set (`TX_FIRST_BLOCK`), not when it becomes null.

4. **Why is there no handler for lost confirmations?**
   - No `TX_LOST_FIRST_BLOCK` event type was implemented.

5. **Why wasn't this case considered?**
   - Implementation oversight. The case where `first_block` becomes `null` was not handled.

## Action Items

| Priority | Action | Owner | Due Date |
|----------|--------|-------|----------|
| P1 | Fix `handleTxFirstBlock` to fetch block height from fullnode API when `first_block` is set | TBD | TBD |
| P1 | Add `TX_LOST_FIRST_BLOCK` handling in `metadataDiff` to reset height to `NULL` when `first_block` becomes null | TBD | TBD |
| P1 | Create migration script to fix existing 1.4M transactions with `height = 0` | TBD | TBD |
| P2 | Add validation: reject/warn when `first_block` is set but `height = 0` | TBD | TBD |
| P2 | Report bug to fullnode team: `metadata.height` should contain block height when `first_block` is set | TBD | TBD |
| P3 | Add monitoring alert for transactions stored with `height = 0` | TBD | TBD |

## Related Items

- `packages/daemon/src/services/index.ts` - `handleTxFirstBlock` function (line 674-707)
- `packages/daemon/src/services/index.ts` - `handleVertexAccepted` function (line 192-479)
- `packages/daemon/src/services/index.ts` - `metadataDiff` function (line 98-178)
- `packages/event-downloader/` - Tool created for this investigation
