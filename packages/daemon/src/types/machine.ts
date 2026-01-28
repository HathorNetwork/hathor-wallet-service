/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ActorRef } from 'xstate';
import { LRU } from '../utils';
import { FullNodeEvent } from './event';

export interface Context {
  socket: ActorRef<any, any> | null;
  healthcheck: ActorRef<any, any> | null;
  retryAttempt: number;
  event?: FullNodeEvent | null;
  initialEventId: null | number;
  txCache: LRU | null;
  rewardMinBlocks?: number | null;
  pendingMetadataChanges?: string[];
}
