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

To run the seed and add the HTR token again, use the following command:

```
yarn dlx sequelize-cli db:seed:all
```

This will ensure the HTR token is present and its transaction count is accurate, even if the database already contains transactions for HTR.
