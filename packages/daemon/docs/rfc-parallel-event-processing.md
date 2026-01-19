# RFC: Parallel Event Processing with Local Event Store

- Feature Name: `parallel_event_processing`
- Start Date: 2025-12-31
- RFC PR: TBD
- Issue: TBD

## Summary
[summary]: #summary

Introduce a local SQLite event store that decouples event downloading from event processing, enabling the daemon to process independent events in parallel. The event downloader continuously fetches events from the fullnode WebSocket and persists them locally. The daemon consumes events from this local store in batches, analyzes dependencies between events, and processes non-conflicting events concurrently.

## Motivation
[motivation]: #motivation

### Current Architecture Problems

The sync-daemon currently processes fullnode events one at a time in a tight loop:

1. Connect to fullnode WebSocket
2. Receive event
3. Process event (database operations)
4. Send ACK
5. Receive next event
6. Repeat

This serial approach has several limitations:

**Performance**: Processing is bottlenecked by the slowest operation in the chain. Even if two events affect completely independent transactions, they are processed sequentially. On initial sync of millions of events, this is painfully slow.

**Coupling**: Event fetching and processing are tightly coupled. If processing is slow, we can't fetch ahead. If the WebSocket disconnects, we lose our place and must reconnect.

**Debugging Difficulty**: Events are ephemeral - once processed, there's no local record. When investigating issues like the `height = 0` bug (see COE_HEIGHT_ZERO.md), we had to build a separate tool to download and store all events for analysis.

**No Replay Capability**: If a bug is discovered in event processing logic, there's no way to replay events to fix the data without re-syncing from the fullnode.

### Use Cases

**Initial Sync Acceleration**: When syncing from scratch, the daemon must process millions of events. Events for independent transactions (different `tx_hash`, no shared UTXOs) can be processed in parallel, potentially reducing sync time by 5-10x depending on hardware.

**Crash Recovery**: If the daemon crashes mid-processing, events are already persisted locally. Recovery is instant - just resume from `last_processed_event_id`.

**Incident Investigation**: When investigating data anomalies, having a complete local history of all events enables root cause analysis without re-downloading from the fullnode.

**Testing and Development**: Developers can replay specific event sequences to test bug fixes or new features against real production data.

## Guide-level explanation
[guide-level-explanation]: #guide-level-explanation

### New Architecture Overview

The daemon is split into two logical components:

```
┌─────────────────┐
│    Fullnode     │
│   (WebSocket)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Event Downloader│  ← Background thread, runs ahead
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     SQLite      │  ← Local event store
│  (events.db)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Event Processor │  ← Reads batches, processes in parallel
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│      MySQL      │  ← Wallet-service database
└─────────────────┘
```

### Key Concepts

**Event Store**: A local SQLite database that stores all events received from the fullnode. Events are immutable once written. The schema matches what we built in `event-downloader`:

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,      -- event ID from fullnode
  type TEXT NOT NULL,          -- event type
  timestamp REAL NOT NULL,     -- event timestamp
  data TEXT NOT NULL           -- full event JSON
);

CREATE TABLE tx_events (
  tx_hash TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  PRIMARY KEY (tx_hash, event_id)
);
```

**Transaction Lane**: A sequence of events affecting the same `tx_hash`. Events within a lane must be processed in order. Different lanes can be processed in parallel if they have no UTXO dependencies.

**Dependency Graph**: A directed acyclic graph (DAG) where nodes are transaction lanes and edges represent UTXO dependencies. If transaction B spends an output from transaction A, there's an edge A → B.

**Batch Processing**: The processor reads N events from SQLite, builds the dependency graph, and processes lanes in topological order with maximum parallelism.

### Example: Processing a Batch

Consider a batch of 6 events:

```
Event 1: NEW_VERTEX_ACCEPTED tx_hash=A (no inputs)
Event 2: NEW_VERTEX_ACCEPTED tx_hash=B (no inputs)
Event 3: NEW_VERTEX_ACCEPTED tx_hash=C (spends from A)
Event 4: VERTEX_METADATA_CHANGED tx_hash=A (first_block set)
Event 5: VERTEX_METADATA_CHANGED tx_hash=B (first_block set)
Event 6: VERTEX_METADATA_CHANGED tx_hash=C (first_block set)
```

The processor builds:

```
Lanes:
  Lane A: [Event 1, Event 4]
  Lane B: [Event 2, Event 5]
  Lane C: [Event 3, Event 6]

Dependencies:
  C depends on A (because tx C spends from tx A)

Execution:
  Parallel: Lane A, Lane B      (no dependencies between them)
  Then:     Lane C              (after A completes)
```

### Configuration

New environment variables:

```bash
# Event store location
EVENT_STORE_PATH=./events.db

# How many events to fetch ahead
DOWNLOAD_BUFFER_SIZE=10000

# Batch size for parallel processing
PROCESS_BATCH_SIZE=1000

# Max parallel lanes (database connections)
MAX_PARALLEL_LANES=10
```

## Reference-level explanation
[reference-level-explanation]: #reference-level-explanation

### Component: Event Downloader

The event downloader runs as a background async task, continuously fetching events from the fullnode and writing them to SQLite.

```typescript
interface EventDownloader {
  start(): Promise<void>;
  stop(): Promise<void>;
  getLatestDownloadedEventId(): number;
}
```

**Connection Management**: Uses the existing WebSocket connection logic from `WebSocketActor`. Maintains a persistent connection with automatic reconnection on failure.

**Write Strategy**: Buffers events and writes in batches of 100 to minimize SQLite write overhead. Uses WAL mode for concurrent read/write access.

**Backpressure**: If SQLite writes fall behind, the downloader slows down ACKs to the fullnode to avoid unbounded memory growth.

### Component: Event Processor

The event processor reads batches from SQLite and processes them with parallelism.

```typescript
interface EventProcessor {
  start(): Promise<void>;
  stop(): Promise<void>;
  getLastProcessedEventId(): number;
}

interface ProcessingBatch {
  events: FullNodeEvent[];
  lanes: Map<string, TransactionLane>;
  dependencyGraph: DependencyGraph;
}

interface TransactionLane {
  txHash: string;
  events: FullNodeEvent[];
  dependsOn: Set<string>;  // tx_hashes this lane must wait for
}
```

### Algorithm: Building the Dependency Graph

```typescript
function buildDependencyGraph(events: FullNodeEvent[]): ProcessingBatch {
  const lanes = new Map<string, TransactionLane>();
  const outputIndex = new Map<string, string>(); // "txHash:index" -> txHash

  for (const event of events) {
    const txHash = extractTxHash(event);
    if (!txHash) continue; // barrier event

    // Get or create lane
    let lane = lanes.get(txHash);
    if (!lane) {
      lane = { txHash, events: [], dependsOn: new Set() };
      lanes.set(txHash, lane);
    }
    lane.events.push(event);

    // For NEW_VERTEX_ACCEPTED, analyze inputs and outputs
    if (event.event.type === 'NEW_VERTEX_ACCEPTED') {
      const data = event.event.data;

      // Register outputs this tx creates
      for (let i = 0; i < data.outputs.length; i++) {
        outputIndex.set(`${txHash}:${i}`, txHash);
      }

      // Check inputs for dependencies
      for (const input of data.inputs) {
        const inputKey = `${input.tx_id}:${input.index}`;
        const dependsOnTx = lanes.get(input.tx_id);

        // Only add dependency if the input tx is in THIS batch
        if (dependsOnTx) {
          lane.dependsOn.add(input.tx_id);
        }
      }
    }
  }

  return { events, lanes, dependencyGraph: buildDAG(lanes) };
}
```

### Algorithm: Dependency Resolution

We use **Kahn's Algorithm** for topological sorting, extended for parallel execution (Level-based Scheduling).

**Kahn's Algorithm** (1962) works by:
1. Find all nodes with no incoming edges (in-degree = 0)
2. Process those nodes, remove them from the graph
3. Repeat until graph is empty

For parallel execution, we extend this to **Level-based Scheduling**:
1. Level 0: All nodes with in-degree = 0 (can run in parallel)
2. Level 1: All nodes whose dependencies are only in Level 0 (can run in parallel after Level 0)
3. Continue until all nodes are assigned levels

```typescript
function assignLevels(lanes: Map<string, TransactionLane>): Map<string, number> {
  const levels = new Map<string, number>();
  const inDegree = new Map<string, number>();

  // Initialize in-degrees
  for (const [txHash, lane] of lanes) {
    inDegree.set(txHash, lane.dependsOn.size);
  }

  // Kahn's algorithm with level tracking
  let currentLevel = 0;
  let remaining = lanes.size;

  while (remaining > 0) {
    // Find all nodes with in-degree 0
    const currentLevelNodes: string[] = [];
    for (const [txHash, degree] of inDegree) {
      if (degree === 0 && !levels.has(txHash)) {
        currentLevelNodes.push(txHash);
        levels.set(txHash, currentLevel);
      }
    }

    if (currentLevelNodes.length === 0) {
      throw new Error('Cycle detected in dependency graph');
    }

    // Remove these nodes and update in-degrees
    for (const txHash of currentLevelNodes) {
      inDegree.delete(txHash);
      remaining--;

      // Decrease in-degree of dependents
      for (const [otherTxHash, lane] of lanes) {
        if (lane.dependsOn.has(txHash)) {
          inDegree.set(otherTxHash, (inDegree.get(otherTxHash) ?? 0) - 1);
        }
      }
    }

    currentLevel++;
  }

  return levels;
}
```

Complexity: O(V + E) where V = number of lanes, E = number of dependencies.

### Algorithm: Parallel Execution

Using the level assignments from Kahn's algorithm:

```typescript
async function processInParallel(batch: ProcessingBatch): Promise<void> {
  const completed = new Set<string>();
  const inProgress = new Map<string, Promise<void>>();
  const lanes = batch.lanes;

  const canStart = (lane: TransactionLane): boolean => {
    return [...lane.dependsOn].every(dep => completed.has(dep));
  };

  while (completed.size < lanes.size) {
    // Start all lanes that have dependencies satisfied
    for (const [txHash, lane] of lanes) {
      if (completed.has(txHash) || inProgress.has(txHash)) continue;

      if (canStart(lane)) {
        const promise = processLane(lane)
          .then(() => {
            completed.add(txHash);
            inProgress.delete(txHash);
          });
        inProgress.set(txHash, promise);

        // Limit parallelism
        if (inProgress.size >= MAX_PARALLEL_LANES) {
          await Promise.race(inProgress.values());
        }
      }
    }

    // If nothing can start, wait for something to complete
    if (inProgress.size > 0) {
      await Promise.race(inProgress.values());
    }
  }
}

async function processLane(lane: TransactionLane): Promise<void> {
  // Each lane gets its own database connection
  const mysql = await getDbConnection();

  try {
    for (const event of lane.events) {
      await processEvent(mysql, event); // existing daemon logic
    }
  } finally {
    mysql.destroy();
  }
}
```

### Barrier Events

Some events cannot be parallelized and act as barriers:

- `LOAD_STARTED` / `LOAD_FINISHED`: Initial sync markers
- `REORG_STARTED` / `REORG_FINISHED`: Reorg markers (though events within are still ordered)
- `FULL_NODE_CRASHED`: Error state

When a barrier event is encountered:
1. Complete all in-progress lanes
2. Process the barrier event
3. Resume parallel processing

### ACK Strategy

The processor only updates `last_processed_event_id` after an entire batch is successfully processed. This ensures:

- On crash, we replay at most one batch
- We never ACK events we haven't fully processed
- The downloader can safely run ahead

### Database Considerations

**MySQL Connection Pool**: Each parallel lane needs its own connection. The pool size should be at least `MAX_PARALLEL_LANES`.

**Transaction Isolation**: Each lane processes events within a single MySQL connection. Different lanes write to different rows (different `tx_hash`), so conflicts are rare. Use `READ COMMITTED` isolation.

**Deadlock Prevention**: Since lanes process different transactions, deadlocks should be rare. If detected, retry the lane.

### Schema Changes

Add to the daemon's database:

```sql
-- Track processing progress
CREATE TABLE IF NOT EXISTS sync_progress (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Store last processed event ID
INSERT INTO sync_progress (key, value) VALUES ('last_processed_event_id', '0');
```

## Drawbacks
[drawbacks]: #drawbacks

**Increased Storage**: Storing all events locally requires disk space. At ~1KB per event average and 8M events, this is ~8GB. For long-running nodes, this could grow significantly.

**Additional Complexity**: Two components (downloader + processor) instead of one. More moving parts means more potential failure modes.

**SQLite Dependency**: Adds SQLite as a runtime dependency. Need to handle SQLite-specific issues (locking, WAL checkpointing, etc.).

**Memory Usage**: Building dependency graphs for large batches requires memory. A batch of 10,000 events might need 50-100MB for the graph structure.

**Debugging Parallel Issues**: Race conditions and parallel bugs are harder to debug than serial processing bugs.

## Rationale and alternatives
[rationale-and-alternatives]: #rationale-and-alternatives

### Why SQLite for the Event Store?

**Considered alternatives**:

1. **In-memory buffer only**: Simpler, but loses events on crash. No replay capability.

2. **Redis**: Fast, but adds operational dependency. Overkill for append-only event log.

3. **PostgreSQL/MySQL**: Could reuse existing MySQL, but adds load to production DB. Event store is write-heavy during sync.

4. **RocksDB/LevelDB**: Faster writes, but more complex API. SQLite is "good enough" and has excellent tooling.

**SQLite wins because**:
- Zero operational overhead (embedded)
- Excellent read performance for sequential access
- Good write performance with WAL mode
- Standard SQL for debugging/analysis
- Already proven in `event-downloader`

### Why Lane-based Parallelism?

**Considered alternatives**:

1. **Event-level parallelism**: Process individual events in parallel. Too fine-grained, high synchronization overhead.

2. **Fixed partitioning**: Hash `tx_hash` to N workers. Simple, but doesn't respect UTXO dependencies.

3. **Full DAG analysis**: Build complete UTXO dependency graph. Most accurate, but expensive to compute.

**Lane-based wins because**:
- Natural grouping (all events for a tx together)
- UTXO dependencies only matter within a batch
- Simple to implement and reason about
- Good parallelism in practice (most txs are independent)

### Impact of Not Doing This

- Initial sync remains slow (hours/days for full history)
- No local event replay for debugging
- No crash resilience for event fetching
- Missed opportunity for the performance improvements needed as the network grows

## Prior art
[prior-art]: #prior-art

### Algorithms

**Kahn's Algorithm (1962)**: Topological sorting algorithm for DAGs. We use this as the foundation for dependency resolution. Original paper: "Topological sorting of large networks" by Arthur B. Kahn.

**Level-based Scheduling**: Extension of topological sort for parallel execution. Nodes are grouped into levels; all nodes in a level can execute in parallel. Common in build systems and compilers.

**Coffman-Graham Algorithm (1972)**: Optimal scheduling algorithm for DAGs on limited processors. Could be used if we need more sophisticated scheduling with processor limits.

**Work-Stealing**: Dynamic load balancing where idle workers steal tasks from busy workers' queues. Used in Java ForkJoinPool, Rust's Rayon, and Tokio. Good for variable task durations.

### Hathor Fullnode (hathor-core)

The hathor-core fullnode already uses Kahn's algorithm for topological sorting in multiple places:

**DAG Builder (`hathor/dag_builder/builder.py:310-346`)**:
```python
def topological_sorting(self) -> Iterator[DAGNode]:
    """Run a topological sort on the DAG, yielding nodes in an order
    that respects all dependency constraints."""
    direct_deps = {}
    rev_deps = defaultdict(set)
    candidates = []

    for name, node in self._nodes.items():
        deps = set(node.get_all_dependencies())
        direct_deps[name] = deps
        for x in deps:
            rev_deps[x].add(name)
        if len(deps) == 0:
            candidates.append(name)

    for _ in range(len(self._nodes)):
        if len(candidates) == 0:
            raise RuntimeError('there is at least one cycle')
        name = candidates.pop()
        # ... remove from dependencies, add new candidates
```

**Nano Contract Sorter (`hathor/nanocontracts/sorter/random_sorter.py:56-192`)**:
- Uses Kahn's algorithm with randomization for deterministic-but-random ordering
- Handles UTXO dependencies via fund DAG edges
- Adds "dummy nodes" between transaction groups with sequence number constraints
- Generates reproducible random order using seeded RNG

**Key insight**: The fullnode processes transactions **serially** but uses topological sort to determine the correct order. We're extending this pattern to enable **parallel execution** of independent transaction lanes while respecting the same dependency constraints.

### Systems

**Kafka Consumer Groups**: Similar pattern of consuming from a log in parallel. Kafka partitions by key, we partition by `tx_hash`. Kafka handles offset tracking, we handle `last_processed_event_id`.

**Bitcoin Core's Block Processing**: Downloads blocks ahead and validates in parallel where possible. UTXO set updates are serialized, but signature validation is parallel.

**Ethereum's Parallel EVM**: Research into parallel transaction execution based on state access patterns. Similar dependency analysis, but at a much finer granularity (storage slots vs UTXOs).

**Block-STM (Aptos)**: Parallel blockchain execution using optimistic concurrency control. Executes transactions speculatively, detects conflicts via read/write sets, re-executes on conflict. Paper: "Block-STM: Scaling Blockchain Execution by Turning Ordering Curse to a Performance Blessing" (2022).

**PostgreSQL Logical Replication**: Streams WAL events to subscribers. Subscribers can process in parallel for different tables. Similar decoupling of fetch and process.

**Event Sourcing / CQRS**: Common pattern of storing events immutably and deriving state. Our event store is essentially an event-sourced log.

### Database Theory

**Conflict Serializability**: Transactions can execute in parallel if they don't conflict (read-write, write-read, write-write on same data). Our lane-based approach ensures transactions affecting different `tx_hash` don't conflict.

**Optimistic Concurrency Control (OCC)**: Assume no conflicts, execute in parallel, validate at commit. If conflict detected, abort and retry. Alternative to our pessimistic dependency analysis.

## Unresolved questions
[unresolved-questions]: #unresolved-questions

**Batch Size Tuning**: What's the optimal batch size? Too small = not enough parallelism. Too large = memory pressure and long commit times. Needs benchmarking.

**UTXO Dependency Detection**: How do we efficiently detect UTXO dependencies? Parsing every `NEW_VERTEX_ACCEPTED` input is expensive. Could we maintain an in-memory UTXO index?

**Error Handling**: If one lane fails, what happens to other lanes? Options:
- Fail entire batch (simple, but wasteful)
- Mark lane as failed, continue others, retry failed lane
- Requires careful tracking of partial progress

**Event Store Retention**: Do we keep events forever or prune old events? If pruning, what's the retention policy?

**Metrics and Observability**: What metrics do we expose? Events downloaded, events processed, batch processing time, lane parallelism achieved, etc.

**Migration Path**: How do we migrate existing daemons? Options:
- Fresh start: re-sync from fullnode
- Backfill: download historical events into SQLite, then switch
- Hybrid: process new events with new system while backfilling

## Future possibilities
[future-possibilities]: #future-possibilities

**Event Replay Tool**: CLI tool to replay specific event ranges for debugging or data recovery. `daemon-replay --from 1000000 --to 2000000`.

**Selective Re-processing**: If a bug is found in event handling logic, replay only affected events without full re-sync.

**Multi-Node Processing**: Shard event processing across multiple daemon instances. Each instance processes a subset of `tx_hash` space.

**Real-time Analytics**: Query the event store for analytics without impacting production. "How many token creations in the last 24 hours?"

**Event Streaming API**: Expose the local event store as an API for other services. Other services can consume events without connecting to fullnode.

**Checkpoint/Snapshot System**: Periodically snapshot the MySQL state and pair with event ID. Enables fast recovery by restoring snapshot + replaying events since.

**Cross-validation**: Run two daemon instances with different processing logic against the same event store. Compare outputs to detect bugs.
