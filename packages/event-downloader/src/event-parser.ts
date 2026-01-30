/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { FullNodeEvent, FullNodeEventTypes } from './types';

/**
 * Extracts the transaction hash from a fullnode event.
 * Now handles ALL event types, not just predefined ones.
 *
 * @param event - The fullnode event to extract the hash from
 * @returns The transaction hash if the event contains one, null otherwise
 */
export function extractTxHash(event: FullNodeEvent): string | null {
  const eventType = event.event.type;
  const eventData = event.event.data as any;

  switch (eventType) {
    case FullNodeEventTypes.NEW_VERTEX_ACCEPTED:
    case FullNodeEventTypes.VERTEX_METADATA_CHANGED:
    case FullNodeEventTypes.VERTEX_REMOVED:
      return eventData?.hash ?? null;

    case FullNodeEventTypes.NC_EVENT:
      return eventData?.vertex_id ?? null;

    case FullNodeEventTypes.LOAD_STARTED:
    case FullNodeEventTypes.LOAD_FINISHED:
    case FullNodeEventTypes.REORG_STARTED:
    case FullNodeEventTypes.REORG_FINISHED:
    case FullNodeEventTypes.FULL_NODE_CRASHED:
      return null;

    default:
      // Handle unknown event types by trying common patterns
      // TOKEN_CREATED and other events might have different structures

      // Try standard hash field
      if (eventData?.hash) {
        return eventData.hash;
      }

      // Try vertex_id (for vertex-related events)
      if (eventData?.vertex_id) {
        return eventData.vertex_id;
      }

      // Try token_uid (for TOKEN_CREATED events)
      if (eventData?.token_uid) {
        return eventData.token_uid;
      }

      // Try nc_exec_info.nc_tx (for nano contract events)
      if (eventData?.nc_exec_info?.nc_tx) {
        return eventData.nc_exec_info.nc_tx;
      }

      // No recognizable hash found
      return null;
  }
}
