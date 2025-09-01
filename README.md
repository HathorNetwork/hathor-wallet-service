Refer to https://github.com/HathorNetwork/rfcs/blob/master/projects/wallet-service-reliable-integration/0001-design.md

# Hathor Wallet Service -- Sync Daemon

## Running

### Local environment

#### System dependencies

You need nodejs installed on your enviroment, we suggest the latest Active LTS version (v18.x.x).

#### Clone the project and install dependencies

`git clone https://github.com/HathorNetwork/hathor-wallet-service-sync_daemon.git`

`npm install`

#### Add env variables or an .env file to the repository:

Example:

```
NETWORK=testnet
DB_ENDPOINT=localhost
DB_PORT=3306
DB_USER=hathor
DB_PASS=hathor
WS_URL=ws://localhost:3003
FULLNODE_PEER_ID=74f75f4df6b19856a75dea6ed894441fbee7768bc561806c7a2fe6368ce4db18
FULLNODE_STREAM_ID=f10ed6b9-8d77-430d-b85f-ae20257af465
ALERT_QUEUE_URL=...
TX_CACHE_SIZE=10000
```

`NETWORK` - The current hathor network we want to connect to
`DB_ENDPOINT` - The MySQL database endpoint we want to connect to
`DB_PORT` - The MySQL database port number
`DB_USER` - The MySQL database username to use
`DB_PASS` - The MySQL database password to use
`WS_URL` - The fullnode event websocket feed
`FULLNODE_PEER_ID` - The fullnode peer id
`FULLNODE_STREAM_ID` - The fullnode stream id
`ALERT_QUEUE_URL` - The alert queue to publish alerts to

If the wallet-service is not running locally, you also need to specify the AWS-SDK env variables:

```
AWS_REGION="us-east-1"
AWS_DEFAULT_REGION="us-east-1"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
```

These are used for communicating with the alert SQS

## Reseeding the HTR Token After Database Reset

If you need to reset the database (for example, to re-sync it from scratch), you must re-insert the HTR token into the `token` table. This is handled by a seed script that will automatically calculate the correct transaction count for HTR based on the current state of the database.

To run the seed and add the HTR token again, you must have a `.env` file in your project root with all required environment variables set. At a minimum, you should include:

```
NODE_ENV=production
DB_ENDPOINT=
DB_NAME=
DB_USER=
DB_PORT=
DB_PASS=
```

Adjust the values as needed for your environment. For production, ensure `NODE_ENV=production` is set.

To run the seed and add the HTR token again, use the following command:

```
yarn dlx sequelize-cli db:seed:all
```

This will ensure the HTR token is present and its transaction count is accurate, even if the database already contains transactions for HTR.

## Database Cleanup

If you need to re-sync the database from scratch, you must stop the daemon and clean all database tables before starting the sync process again. This ensures there is no leftover data that could cause inconsistencies.

Below is a SQL script you can use to clean up (truncate) all tables in the database. This script disables foreign key checks, truncates all tables, and then re-enables foreign key checks. **Be careful: this will delete all data in the database.**

```
SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE address_balance;
TRUNCATE TABLE address_tx_history;
TRUNCATE TABLE address;
TRUNCATE TABLE miner;
TRUNCATE TABLE push_devices;
TRUNCATE TABLE sync_metadata;
TRUNCATE TABLE token;
TRUNCATE TABLE transaction;
TRUNCATE TABLE tx_output;
TRUNCATE TABLE tx_proposal;
TRUNCATE TABLE wallet;
TRUNCATE TABLE wallet_balance;
TRUNCATE TABLE wallet_tx_history;
TRUNCATE TABLE version_data;

SET FOREIGN_KEY_CHECKS = 1;
```

To use this script, save it as `cleanup.sql` and run:

```
mysql -u <user> -p <database> < cleanup.sql
```

After cleaning the database, you can reseed the HTR token as described in the previous section.

## Running Inside Containers
When running these applications inside containers, it's worth noting that there are a few Dockerfiles in this monorepo.

### 1) The Daemon container
This Dockerfile is located at `./packages/daemon` and is used to build the sync daemon image. It, however,needs a properly migrated database and all the fullnode identifiers to run correctly.

The fullnode identifiers may be fetched dynamically at startup with the use of the `FETCH_FULLNODE_IDS` environment variable, provided the remaining fullnode connection config is available. Please note that this dynamic fetching is only recommended in development environments, as the identifiers are an additional security measure on production builds.

### 2) The Migrator container
The Migrator Dockerfile is located at `./db` and is used to build the migrator image then shut off. This image is responsible for applying database migrations to the database connection passed through the environment variables.

It's specially important if the database has just been created by the dockerized environment, in which case run this migrator container before starting the daemon. This, again, is only expected in discardable development environments, as production and other more persistent databases should be managed externally.

Its image can be build using the `make build-migrator` while on the root folder.

### 3) The Wallet Service container
This is the actual serverless application containing the externally consumed API. Its Dockerfile is located at `./packages/wallet-service` and is used to build the wallet service image. It needs a healthy Daemon to run correctly.
