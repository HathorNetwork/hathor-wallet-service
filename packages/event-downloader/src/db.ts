import Database, { Database as DatabaseType } from 'better-sqlite3';

// Types
export interface Event {
  id: number;
  type: string;
  timestamp: number;
  data: string;
}

export interface TxEvent {
  tx_hash: string;
  event_id: number;
  event_type: string;
}

export interface BatchProgress {
  batch_start: number;
  batch_end: number;
  last_downloaded: number | null;
  status: string;
  updated_at: string;
}

// SQL statements
const CREATE_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_TX_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS tx_events (
    tx_hash TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    PRIMARY KEY (tx_hash, event_id)
  )
`;

const CREATE_DOWNLOAD_PROGRESS_TABLE = `
  CREATE TABLE IF NOT EXISTS download_progress (
    batch_start INTEGER PRIMARY KEY,
    batch_end INTEGER NOT NULL,
    last_downloaded INTEGER,
    status TEXT DEFAULT 'pending',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_TX_EVENTS_HASH_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_tx_events_hash ON tx_events(tx_hash)
`;

const CREATE_EVENTS_TYPE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)
`;

/**
 * Initialize the database with all required tables and indexes.
 * @param dbPath - Path to the SQLite database file
 * @returns The database instance
 */
export function initDatabase(dbPath: string): DatabaseType {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(CREATE_EVENTS_TABLE);
  db.exec(CREATE_TX_EVENTS_TABLE);
  db.exec(CREATE_DOWNLOAD_PROGRESS_TABLE);

  // Create indexes
  db.exec(CREATE_TX_EVENTS_HASH_INDEX);
  db.exec(CREATE_EVENTS_TYPE_INDEX);

  return db;
}

/**
 * Batch insert events into the events table.
 * Uses INSERT OR REPLACE to handle duplicates.
 * @param db - Database instance
 * @param events - Array of events to insert
 */
export function insertEvents(db: DatabaseType, events: Event[]): void {
  if (events.length === 0) {
    return;
  }

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO events (id, type, timestamp, data)
    VALUES (@id, @type, @timestamp, @data)
  `);

  const insertMany = db.transaction((eventsToInsert: Event[]) => {
    for (const event of eventsToInsert) {
      insertStmt.run(event);
    }
  });

  insertMany(events);
}

/**
 * Batch insert transaction event mappings into the tx_events table.
 * Uses INSERT OR REPLACE to handle duplicates.
 * @param db - Database instance
 * @param txEvents - Array of transaction events to insert
 */
export function insertTxEvents(db: DatabaseType, txEvents: TxEvent[]): void {
  if (txEvents.length === 0) {
    return;
  }

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO tx_events (tx_hash, event_id, event_type)
    VALUES (@tx_hash, @event_id, @event_type)
  `);

  const insertMany = db.transaction((txEventsToInsert: TxEvent[]) => {
    for (const txEvent of txEventsToInsert) {
      insertStmt.run(txEvent);
    }
  });

  insertMany(txEvents);
}

/**
 * Get the progress for a specific batch.
 * @param db - Database instance
 * @param batchStart - The starting event ID of the batch
 * @returns The batch progress record or undefined if not found
 */
export function getBatchProgress(
  db: DatabaseType,
  batchStart: number
): BatchProgress | undefined {
  const stmt = db.prepare(`
    SELECT batch_start, batch_end, last_downloaded, status, updated_at
    FROM download_progress
    WHERE batch_start = ?
  `);

  return stmt.get(batchStart) as BatchProgress | undefined;
}

/**
 * Update or insert batch progress.
 * Uses INSERT OR REPLACE to upsert the record.
 * @param db - Database instance
 * @param batchStart - The starting event ID of the batch
 * @param batchEnd - The ending event ID of the batch
 * @param lastDownloaded - The last successfully downloaded event ID (null if none)
 * @param status - The status of the batch ('pending', 'in_progress', 'completed', etc.)
 */
export function updateBatchProgress(
  db: DatabaseType,
  batchStart: number,
  batchEnd: number,
  lastDownloaded: number | null,
  status: string
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO download_progress (batch_start, batch_end, last_downloaded, status, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  stmt.run(batchStart, batchEnd, lastDownloaded, status);
}

/**
 * Get all batches that are not marked as 'completed'.
 * @param db - Database instance
 * @returns Array of pending batch progress records
 */
export function getPendingBatches(db: DatabaseType): BatchProgress[] {
  const stmt = db.prepare(`
    SELECT batch_start, batch_end, last_downloaded, status, updated_at
    FROM download_progress
    WHERE status != 'completed'
    ORDER BY batch_start ASC
  `);

  return stmt.all() as BatchProgress[];
}

/**
 * Get all batch progress records.
 * @param db - Database instance
 * @returns Array of all batch progress records
 */
export function getAllBatchProgress(db: DatabaseType): BatchProgress[] {
  const stmt = db.prepare(`
    SELECT batch_start, batch_end, last_downloaded, status, updated_at
    FROM download_progress
    ORDER BY batch_start ASC
  `);

  return stmt.all() as BatchProgress[];
}

/**
 * Get the highest event ID currently stored in the database.
 * @param db - Database instance
 * @returns The highest event ID or null if no events exist
 */
export function getLastEventId(db: DatabaseType): number | null {
  const stmt = db.prepare(`
    SELECT MAX(id) as last_id FROM events
  `);

  const result = stmt.get() as { last_id: number | null };
  return result?.last_id ?? null;
}
