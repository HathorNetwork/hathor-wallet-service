// Db information
export const DB_USER = 'root';
export const DB_PASS = 'hathor';
export const DB_NAME = 'hathor';
export const DB_PORT = 3380;
export const DB_ENDPOINT = '127.0.0.1';

// unvoided
export const UNVOIDED_SCENARIO_PORT = 8081;

// Last event is actually 39, but event 39 is ignored by the machine (because
// the transaction is already added), and when we ignore an event, we don't store
// it in the database.
export const UNVOIDED_SCENARIO_LAST_EVENT = 38;

// reorg
export const REORG_SCENARIO_PORT = 8082;
// Same as the comment on the unvoided scenario last event
export const REORG_SCENARIO_LAST_EVENT = 19;


// single chain blocks and transactions port
export const SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_PORT = 8083;
// Same as the comment on the unvoided scenario last event
export const SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_LAST_EVENT = 37;


export const INVALID_MEMPOOL_TRANSACTION_PORT = 8085;
export const INVALID_MEMPOOL_TRANSACTION_LAST_EVENT = 40;

export const SCENARIOS = ['UNVOIDED_SCENARIO', 'REORG_SCENARIO', 'SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS', 'INVALID_MEMPOOL_TRANSACTION'];
