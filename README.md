# Hathor Wallet Service -- Sync Daemon

## State Machine

The state machine diagram can be visualized at https://gist.github.com/andreabadesso/7299c0ed0ce189bc121a06dce1e11638

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
