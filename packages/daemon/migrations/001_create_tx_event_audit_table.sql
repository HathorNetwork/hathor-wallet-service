-- Migration: Create transaction event audit table
-- Purpose: Track which events trigger changes to which transactions for debugging and audit purposes

CREATE TABLE IF NOT EXISTS `tx_event_audit` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tx_id` VARCHAR(64) NOT NULL,
  `event_id` BIGINT NOT NULL,
  `event_type` VARCHAR(32) NOT NULL COMMENT 'TX_NEW, TX_VOIDED, TX_UNVOIDED, TX_FIRST_BLOCK, TX_REMOVED',
  `event_data` JSON NOT NULL COMMENT 'Complete event data in JSON format',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_tx_id` (`tx_id`),
  INDEX `idx_event_id` (`event_id`),
  INDEX `idx_event_type` (`event_type`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Audit log tracking which events triggered changes to which transactions';
