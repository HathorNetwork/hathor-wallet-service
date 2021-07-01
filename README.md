# Hathor Wallet Service -- Sync Daemon

## Running

### Local environment

#### System dependencies

You need nodejs installed on your enviroment, we are using the latest Active LTS version (v14.16.1) on the dev environment. You can read more about installing nodejs on https://nodejs.org/en/download/package-manager/

#### Clone the project and install dependencies

`git clone https://github.com/HathorNetwork/hathor-wallet-service-sync_daemon.git && npm install`

#### Add env variables or an .env file to the repository:

Example:

```
NETWORK=testnet
MAX_ADDRESS_GAP=20
WALLET_SERVICE_NAME=hathor-wallet-service
WALLET_SERVICE_STAGE=local
DEFAULT_SERVER=http://fullnode_url/v1a/
```

`NETWORK` - The current hathor network we want to connect to
`MAX_ADDRESS_GAP` - The full-node configured GAP between addresses
`WALLET_SERVICE_NAME` - The Wallet-Service's service name as it was registered on AWS
`WALLET_SERVICE_STAGE` - Wallet-Service's deployment stage, e.g. `local`, `production`, `staging`
`DEFAULT_SERVER` - The full-node API url

If the wallet-service is not running locally, you also need to specify the AWS-SDK env variables:

```
AWS_REGION="us-east-1"
AWS_DEFAULT_REGION="us-east-1"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
```

#### Run:

`npm start`


### Deploy

The recommended way to deploy this service is to use docker.

#### Building the image:

`docker build -t hathor/sync-daemon .`

#### Running:

```
docker run -d -e WALLET_SERVICE_STAGE="production" \
           -e NODE_ENV="production" \
           -e AWS_REGION="us-east-1" \
           -e AWS_DEFAULT_REGION="us-east-1" \
           -e AWS_ACCESS_KEY_ID="..." \
           -e AWS_SECRET_ACCESS_KEY="..." \
           -e NETWORK="testnet" \
           -e MAX_ADDRESS_GAP=20 \
           -e NETWORK="testnet" \
           -e WALLET_SERVICE_NAME="hathor-wallet-service" \
           -e DEFAULT_SERVER="http://fullnode:8082/v1a/" \
           -ti localhost/hathor/sync-daemon
```

In this example, we are passing the env variables to the container and running as a daemon (`-d`). We are also expecting a fullnode to be running on fullnode:8082.

## State Machine

The state machine diagram can be visualized at https://xstate.js.org/viz/?gist=19dd8bc6d62533add23e124ef31adb78

## States:

### Idle

The machine starts at the idle state, it will stay there until a `NEW_BLOCK` action is received.

Every time the state of the machine is transitioned to `idle`, the machine will check if `hasMoreBlocks` is set on the state context. If it is, the machine will transition to `syncing`.

#### Actions:
  `NEW_BLOCK`: When a `NEW_BLOCK` action is received, the machine will transition to the `syncing` state.

### Syncing

Everytime the state of the machine is transitioned to `syncing`, the machine will invoke the `syncHandler` service that will start syncing new blocks.

#### Actions:
  `NEW_BLOCK`: When a `NEW_BLOCK` action is received, the machine will assign `true` to the `hasMoreBlocks` context on the state, so the next time we transition to `IDLE`, the machine will know that there are more blocks to be downloaded.
  `DONE`: When a `DONE` action is received, the machine will transition to `idle` to await for new blocks
  `ERROR`: When a `ERROR` action is received, the machine will transition to the `failure` state
  `REORG`: When a `REORG` action is received, the machine will transition to the `reorg` state
  `STOP`: When a `STOP` action is received, the machine will transition to the `idle` state

### Failure

This is a `final` state, meaning that the machine will ignore all actions and wait for a manual restart.

This state can trigger actions to try to automatically solve issues or notify us about it.

### Reorg

This is temporarily a `final` state, this will be changed on a new PR with the reorg code.
