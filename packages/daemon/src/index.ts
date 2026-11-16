/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Must be imported before all other modules to patch libraries for auto-instrumentation
import './tracing';

import { main } from './main';

main();
