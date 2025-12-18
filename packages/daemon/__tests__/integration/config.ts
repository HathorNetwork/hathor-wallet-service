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
export const UNVOIDED_SCENARIO_LAST_EVENT = 39;

// reorg
export const REORG_SCENARIO_PORT = 8082;
// Same as the comment on the unvoided scenario last event
export const REORG_SCENARIO_LAST_EVENT = 18;


// single chain blocks and transactions port
export const SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_PORT = 8083;
// Same as the comment on the unvoided scenario last event
export const SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS_LAST_EVENT = 37;


export const INVALID_MEMPOOL_TRANSACTION_PORT = 8085;
export const INVALID_MEMPOOL_TRANSACTION_LAST_EVENT = 40;

export const CUSTOM_SCRIPT_PORT = 8086;
export const CUSTOM_SCRIPT_LAST_EVENT = 37;

export const EMPTY_SCRIPT_PORT = 8087;
export const EMPTY_SCRIPT_LAST_EVENT = 37;

export const NC_EVENTS_PORT = 8088;
export const NC_EVENTS_LAST_EVENT = 36;

export const TRANSACTION_VOIDING_CHAIN_PORT = 8089;
export const TRANSACTION_VOIDING_CHAIN_LAST_EVENT = 52;

export const VOIDED_TOKEN_AUTHORITY_PORT = 8090;
export const VOIDED_TOKEN_AUTHORITY_LAST_EVENT = 66;

export const SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION_PORT = 8091;
export const SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION_LAST_EVENT = 50;

export const SINGLE_VOIDED_REGULAR_TRANSACTION_PORT = 8092;
export const SINGLE_VOIDED_REGULAR_TRANSACTION_LAST_EVENT = 60;

export const SCENARIOS = [
  'UNVOIDED_SCENARIO',
  'REORG_SCENARIO',
  'SINGLE_CHAIN_BLOCKS_AND_TRANSACTIONS',
  'INVALID_MEMPOOL_TRANSACTION',
  'EMPTY_SCRIPT',
  'CUSTOM_SCRIPT',
  'NC_EVENTS',
  'TRANSACTION_VOIDING_CHAIN',
  'VOIDED_TOKEN_AUTHORITY',
  'SINGLE_VOIDED_CREATE_TOKEN_TRANSACTION',
  'SINGLE_VOIDED_REGULAR_TRANSACTION',
];
