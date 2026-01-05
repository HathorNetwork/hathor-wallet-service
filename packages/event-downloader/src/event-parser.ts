/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { FullNodeEvent, FullNodeEventTypes } from './types';

/**
 * Extracts the transaction hash from a fullnode event.
 *
 * @param event - The fullnode event to extract the hash from
 * @returns The transaction hash if the event contains one, null otherwise
 */
export function extractTxHash(event: FullNodeEvent): string | null {
  const eventType = event.event.type;

  switch (eventType) {
    case FullNodeEventTypes.NEW_VERTEX_ACCEPTED:
    case FullNodeEventTypes.VERTEX_METADATA_CHANGED:
    case FullNodeEventTypes.VERTEX_REMOVED:
      return event.event.data.hash;

    case FullNodeEventTypes.NC_EVENT:
      return event.event.data.vertex_id;

    case FullNodeEventTypes.LOAD_STARTED:
    case FullNodeEventTypes.LOAD_FINISHED:
    case FullNodeEventTypes.REORG_STARTED:
    case FullNodeEventTypes.REORG_FINISHED:
    case FullNodeEventTypes.FULL_NODE_CRASHED:
      return null;

    default:
      return null;
  }
}
