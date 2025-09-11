/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export default {
  addressBalances: {
    // HFtz2f59Lms4p3Jfgtsr73s97MbJHsRENh - token efb08b...: unlocked=0, locked=0, authorities: 0 unlocked + 0 locked
    'HFtz2f59Lms4p3Jfgtsr73s97MbJHsRENh:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': { 
      unlockedBalance: 0n, 
      lockedBalance: 0n,
      authorities: { locked: 0, unlocked: 0 }
    },
    // HJQbEERnD5Ak3f2dsi8zAmsZrCWTT8FZns - token efb08b...: unlocked=0, locked=0, authorities: 1 unlocked + 0 locked  
    'HJQbEERnD5Ak3f2dsi8zAmsZrCWTT8FZns:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': { 
      unlockedBalance: 0n, 
      lockedBalance: 0n,
      authorities: { locked: 0, unlocked: 1 }
    },
    // HRQe4CXj8AZXzSmuNztU8iQR74QTQMbnTs - HTR (00): unlocked=6390, locked=115200
    'HRQe4CXj8AZXzSmuNztU8iQR74QTQMbnTs:00': { 
      unlockedBalance: 6390n, 
      lockedBalance: 115200n 
    },
    // HRQe4CXj8AZXzSmuNztU8iQR74QTQMbnTs - token efb08b...: unlocked=1000, locked=0, authorities: 2 unlocked + 0 locked
    'HRQe4CXj8AZXzSmuNztU8iQR74QTQMbnTs:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': {
      unlockedBalance: 1000n,
      lockedBalance: 0n,
      authorities: { locked: 0, unlocked: 2 }
    },
    // HRXVDmLVdq8pgok1BCUKpiFWdAVAy4a5AJ - HTR (00): unlocked=0, locked=100000000000
    'HRXVDmLVdq8pgok1BCUKpiFWdAVAy4a5AJ:00': { 
      unlockedBalance: 0n, 
      lockedBalance: 100000000000n 
    },
  },
  walletBalances: {
    // deafbeef wallet HTR balance: unlocked=6390, locked=100000115200
    'deafbeef:00': { unlockedBalance: 6390n, lockedBalance: 100000115200n },
    // deafbeef wallet token efb08b... balance: unlocked=1000, locked=0, authorities: 2 unlocked + 0 locked
    'deafbeef:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': { 
      unlockedBalance: 1000n, 
      lockedBalance: 0n,
      authorities: { locked: 0, unlocked: 2 } 
    },
    // cafecafe wallet token efb08b... balance: unlocked=0, locked=0, authorities: 1 unlocked + 0 locked
    'cafecafe:efb08b3e79e0ddaa6bc288183f66fe49a07ba0b7b2595861000478cc56447539': { 
      unlockedBalance: 0n, 
      lockedBalance: 0n,
      authorities: { locked: 0, unlocked: 1 } 
    },
  },
};
