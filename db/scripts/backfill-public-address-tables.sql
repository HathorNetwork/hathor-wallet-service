-- Backfill `public_address_tx_history` and `public_address_tokens` from data
-- already stored, for an environment that ingested vertices before the tables
-- existed. See docs/SOP.md for when and how to run it.
--
-- Run it with the daemon stopped: a vertex ingested or voided while it runs
-- could be missed or kept.
--
--   mysql -h <host> -u <user> -p <database> < db/scripts/backfill-public-address-tables.sql
--
-- It applies the rule the daemon applies at ingest (`getPublicInvolvement` in
-- packages/daemon/src/utils/publicInvolvement.ts), from public columns only.
-- Per (address, token, transaction), over non-voided transactions:
--  - every `tx_output` row counts as an output of its `tx_id` and, when spent,
--    as an input of its `spent_by`;
--  - a transparent row (mode 0) counts under its token, adding (output) or
--    subtracting (input) its value unless it is an authority;
--  - an AmountShielded row (mode 1) counts under its token with no balance, or
--    under 'fully_shielded' when its token is unknown;
--  - a FullyShielded row (mode 2) counts under 'fully_shielded' with no
--    balance;
--  - a nano-contract caller has no `tx_output` row. Its row is the
--    `address_tx_history` HTR row with a zero balance whose (address, tx) has
--    no `tx_output` row as an output or an input; it is copied with no balance.
-- A shielded row's value, a FullyShielded row's token, its recovery state and
-- every shielded column of the history and balance tables are never read.
-- `tx_output.value` is unsigned, so it is cast before it is negated.
-- The daemon's tests run this file and compare its result with what ingest
-- writes, so the two cannot drift apart unnoticed.
--
-- Addresses are processed in batches of `@batch_size` from the `address`
-- table, each batch in its own transaction; the last batch is open-ended and
-- also takes any address missing from that table. History rows are upserted,
-- and each batch's counters are rebuilt from its history rows in the same
-- transaction, so the script can be run again from the start. Each batch
-- prints the last address it covered; to resume after a failure, set
-- `@resume_after` to it.

SET @batch_size = 1000;
SET @resume_after = '';

DROP PROCEDURE IF EXISTS `backfill_public_address_tables`;

DELIMITER $$

CREATE PROCEDURE `backfill_public_address_tables`(IN p_after VARCHAR(34), IN p_batch_size INT)
BEGIN
  DECLARE v_after VARCHAR(34) DEFAULT p_after;
  DECLARE v_up_to VARCHAR(34);
  DECLARE v_offset INT DEFAULT p_batch_size - 1;
  DECLARE v_done BOOLEAN DEFAULT FALSE;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  WHILE NOT v_done DO
    -- The batch is (v_after, v_up_to]; a NULL v_up_to is open-ended.
    SET v_up_to = (SELECT `address`
                     FROM `address`
                    WHERE `address` > v_after
                    ORDER BY `address`
                    LIMIT v_offset, 1);
    SET v_done = v_up_to IS NULL;

    START TRANSACTION;

    INSERT INTO `public_address_tx_history`
           (`address`, `token_id`, `timestamp`, `tx_id`, `balance`, `has_shielded`)
    SELECT io.`address`, io.`token_id`, t.`timestamp`, io.`tx_id`, SUM(io.`balance`), MAX(io.`shielded`)
      FROM (
        SELECT o.`tx_id` AS `tx_id`, o.`address`,
               CASE o.`mode`
                 WHEN 0 THEN o.`token_id`
                 WHEN 1 THEN COALESCE(o.`token_id`, 'fully_shielded')
                 WHEN 2 THEN 'fully_shielded'
               END AS `token_id`,
               CASE WHEN o.`mode` = 0 AND o.`authorities` = 0 THEN CAST(o.`value` AS SIGNED) ELSE 0 END AS `balance`,
               o.`mode` <> 0 AS `shielded`
          FROM `tx_output` o
         WHERE o.`address` > v_after AND (v_up_to IS NULL OR o.`address` <= v_up_to)
           AND o.`voided` = FALSE
        UNION ALL
        SELECT o.`spent_by`, o.`address`,
               CASE o.`mode`
                 WHEN 0 THEN o.`token_id`
                 WHEN 1 THEN COALESCE(o.`token_id`, 'fully_shielded')
                 WHEN 2 THEN 'fully_shielded'
               END,
               CASE WHEN o.`mode` = 0 AND o.`authorities` = 0 THEN -CAST(o.`value` AS SIGNED) ELSE 0 END,
               o.`mode` <> 0
          FROM `tx_output` o
         WHERE o.`address` > v_after AND (v_up_to IS NULL OR o.`address` <= v_up_to)
           AND o.`voided` = FALSE
           AND o.`spent_by` IS NOT NULL
        UNION ALL
        SELECT h.`tx_id`, h.`address`, '00', 0, FALSE
          FROM `address_tx_history` h
         WHERE h.`address` > v_after AND (v_up_to IS NULL OR h.`address` <= v_up_to)
           AND h.`token_id` = '00'
           AND h.`balance` = 0
           AND NOT EXISTS (SELECT 1 FROM `tx_output` o
                            WHERE o.`tx_id` = h.`tx_id` AND o.`address` = h.`address`)
           AND NOT EXISTS (SELECT 1 FROM `tx_output` o
                            WHERE o.`spent_by` = h.`tx_id` AND o.`address` = h.`address`)
      ) io
      JOIN `transaction` t ON t.`tx_id` = io.`tx_id`
     WHERE t.`voided` = FALSE
     GROUP BY io.`address`, io.`token_id`, io.`tx_id`, t.`timestamp`
        ON DUPLICATE KEY UPDATE `balance` = VALUES(`balance`), `has_shielded` = VALUES(`has_shielded`);

    -- The counters, from the history rows as they now stand.
    DELETE FROM `public_address_tokens`
     WHERE `address` > v_after AND (v_up_to IS NULL OR `address` <= v_up_to);
    INSERT INTO `public_address_tokens`
           (`address`, `token_id`, `transactions`, `shielded_transactions`, `last_activity`)
    SELECT `address`, `token_id`, COUNT(*), SUM(`has_shielded`), MAX(`timestamp`)
      FROM `public_address_tx_history`
     WHERE `address` > v_after AND (v_up_to IS NULL OR `address` <= v_up_to)
     GROUP BY `address`, `token_id`;

    COMMIT;

    SELECT NOW() AS `at`, COALESCE(v_up_to, '(end)') AS `done_through`;
    SET v_after = v_up_to;
  END WHILE;
END$$

DELIMITER ;

CALL `backfill_public_address_tables`(@resume_after, @batch_size);

DROP PROCEDURE `backfill_public_address_tables`;

-- Nano-contract caller rows written: '00' rows with no balance and no
-- `tx_output` row for their (address, tx).
SELECT COUNT(*) AS `nano_caller_rows`
  FROM `public_address_tx_history` p
 WHERE p.`token_id` = '00'
   AND p.`balance` = 0
   AND p.`has_shielded` = FALSE
   AND NOT EXISTS (SELECT 1 FROM `tx_output` o
                    WHERE o.`tx_id` = p.`tx_id` AND o.`address` = p.`address`)
   AND NOT EXISTS (SELECT 1 FROM `tx_output` o
                    WHERE o.`spent_by` = p.`tx_id` AND o.`address` = p.`address`);
