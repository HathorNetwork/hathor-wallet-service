### Motivation

A single `VERTEX_METADATA_CHANGED` event can contain multiple independent changes (e.g., `nc_execution` voided AND `first_block` changed during reorg). Previously `metadataDiff` returned one type and routed to one handler, losing the second change.

### Acceptance Criteria

- `metadataDiff` detects all independent metadata changes in a single event and returns them as an array
- A dispatch queue processes each change one-by-one before returning to idle
- `handleNcExecVoided` no longer needs to know about `first_block` — each handler has a single responsibility
- No new dependencies added

### Checklist
- [ ] If you are requesting a merge into `master`, confirm this code is production-ready and can be included in future releases as soon as it gets merged
- [ ] Make sure either the unit tests and/or the QA tests are capable of testing the new features
- [ ] Make sure you do not include new dependencies in the project unless strictly necessary and do not include dev-dependencies as production ones. More dependencies increase the possibility of one of them being hijacked and affecting us.

### What changed

**`metadataDiff`** now returns `{ types: string[], originalEvent }` instead of `{ type, originalEvent }`. Mutually exclusive changes (voided/unvoided/new) still return a single element. Independent changes (`NC_EXEC_VOIDED`, `TX_FIRST_BLOCK`) are collected into the same array.

**`handlingMetadataChanged`** gains a `dispatching` substate that loops: it reads `context.pendingMetadataChanges[0]`, routes to the matching handler via `always` guards, and shifts the queue. Each handler's `onDone` returns to the dispatcher. When the queue is empty, it falls through to `handlingUnhandledEvent` → idle + sendAck.

**New actions**: `storeMetadataChanges` (stores the types array and original event on `onDone` from `metadataDiff`) and `shiftMetadataChange` (pops the first element).

**New guards**: `nextChangeIsVoided`, `nextChangeIsUnvoided`, `nextChangeIsNewTx`, `nextChangeIsFirstBlock`, `nextChangeIsNcExecVoided` — all check `context.pendingMetadataChanges[0]`.

**`handleNcExecVoided`** simplified: only deletes nano tokens + updates last synced event. The first_block detection/chaining logic is removed since the dispatcher handles it.

**Removed**: `METADATA_DECIDED` event type, `MetadataDecidedEvent` type, `metadataDecided` raise action, `unwrapEvent` action, all old metadata guards, `ncExecVoidedFirstBlockChanged` guard.
