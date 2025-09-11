/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export default {
  addressBalances: {
    'HRQe4CXj8AZXzSmuNztU8iQR74QTQMbnTs:00': { unlockedBalance: 6390n, lockedBalance: 115200n },
    'HRQe4CXj8AZXzSmuNztU8iQR74QTQMbnTs:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': {
      unlockedBalance: 1000n,
      lockedBalance: 0n,
      authorities: { unlocked: 2, locked: 0 }
    },
    'HRXVDmLVdq8pgok1BCUKpiFWdAVAy4a5AJ:00': { unlockedBalance: 0n, lockedBalance: 100000000000n },
    'HJQbEERnD5Ak3f2dsi8zAmsZrCWTT8FZns:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': {
      unlockedBalance: 0n,
      lockedBalance: 0n,
      authorities: { unlocked: 1, locked: 0 }
    },
    'HFtz2f59Lms4p3Jfgtsr73s97MbJHsRENh:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': {
      unlockedBalance: 0n,
      lockedBalance: 0n,
      authorities: { unlocked: 0, locked: 0 }
    }
  },
  walletBalances: {
    // HTH balance: 6390 unlocked + 115200 locked (HRQe4CXj8AZXzSmuNztU8iQR74QTQMbnTs) + 0 unlocked + 100000000000 locked (HRXVDmLVdq8pgok1BCUKpiFWdAVAy4a5AJ)
    'deafbeef:00': { unlockedBalance: 6390n, lockedBalance: 100000115200n },
    'deafbeef:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': {
      unlockedBalance: 1000n,
      lockedBalance: 0n,
      authorities: { unlocked: 2, locked: 0 }
    },
    'deadbeef:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': {
      unlockedBalance: 0n,
      lockedBalance: 0n,
      authorities: { unlocked: 0, locked: 0 }
    }
  },
};
