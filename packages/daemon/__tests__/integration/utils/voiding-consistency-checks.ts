/**
 * Database consistency checks for transaction voiding scenarios
 */

import { Connection, RowDataPacket } from 'mysql2/promise';

interface TransactionRow extends RowDataPacket {
  tx_id: string;
  voided: number; // MySQL TINYINT/BOOLEAN comes back as number (0 or 1)
}

interface UtxoRow extends RowDataPacket {
  tx_id: string;
  index: number;
  value: string;
  voided: number; // MySQL TINYINT/BOOLEAN comes back as number (0 or 1)
  spent_by: string | null;
}

export interface VoidingConsistencyCheck {
  transactionStatuses: {
    txId: string;
    voided: boolean;
    expected: boolean;
  }[];
  utxoStatuses: {
    txId: string;
    index: number;
    value: number;
    voided: boolean;
    spentBy: string | null;
    expectedVoided: boolean;
    expectedSpentBy: string | null;
  }[];
}

export const performVoidingConsistencyChecks = async (
  mysql: Connection,
  expectedChecks: {
    transactions: { txId: string; expectedVoided: boolean }[];
    utxos: {
      txId: string;
      index: number;
      expectedValue: number;
      expectedVoided: boolean;
      expectedSpentBy: string | null;
    }[];
  }
): Promise<VoidingConsistencyCheck> => {
  const results: VoidingConsistencyCheck = {
    transactionStatuses: [],
    utxoStatuses: [],
  };

  // Check transaction voiding statuses
  for (const expectedTx of expectedChecks.transactions) {
    const [rows] = await mysql.query<TransactionRow[]>(
      'SELECT tx_id, voided FROM `transaction` WHERE tx_id = ?',
      [expectedTx.txId]
    );

    const actualVoided = rows.length > 0 ? rows[0].voided === 1 : false;
    results.transactionStatuses.push({
      txId: expectedTx.txId,
      voided: actualVoided,
      expected: expectedTx.expectedVoided,
    });
  }

  // Check UTXO statuses
  for (const expectedUtxo of expectedChecks.utxos) {
    const [rows] = await mysql.query<UtxoRow[]>(
      'SELECT tx_id, `index`, value, voided, spent_by FROM `tx_output` WHERE tx_id = ? AND `index` = ?',
      [expectedUtxo.txId, expectedUtxo.index]
    );

    if (rows.length > 0) {
      const utxo = rows[0];
      results.utxoStatuses.push({
        txId: expectedUtxo.txId,
        index: expectedUtxo.index,
        value: parseInt(utxo.value),
        voided: utxo.voided === 1,
        spentBy: utxo.spent_by,
        expectedVoided: expectedUtxo.expectedVoided,
        expectedSpentBy: expectedUtxo.expectedSpentBy,
      });
    } else {
      // UTXO not found
      results.utxoStatuses.push({
        txId: expectedUtxo.txId,
        index: expectedUtxo.index,
        value: 0,
        voided: false,
        spentBy: null,
        expectedVoided: expectedUtxo.expectedVoided,
        expectedSpentBy: expectedUtxo.expectedSpentBy,
      });
    }
  }

  return results;
};

export const validateVoidingConsistency = (checks: VoidingConsistencyCheck): void => {
  const errors: string[] = [];

  // Validate transaction statuses
  for (const txCheck of checks.transactionStatuses) {
    if (txCheck.voided !== txCheck.expected) {
      errors.push(
        `Transaction ${txCheck.txId}: expected voided=${txCheck.expected}, got voided=${txCheck.voided}`
      );
    }
  }

  // Validate UTXO statuses
  for (const utxoCheck of checks.utxoStatuses) {
    if (utxoCheck.voided !== utxoCheck.expectedVoided) {
      errors.push(
        `UTXO ${utxoCheck.txId}:${utxoCheck.index}: expected voided=${utxoCheck.expectedVoided}, got voided=${utxoCheck.voided}`
      );
    }

    if (utxoCheck.spentBy !== utxoCheck.expectedSpentBy) {
      errors.push(
        `UTXO ${utxoCheck.txId}:${utxoCheck.index}: expected spentBy=${utxoCheck.expectedSpentBy}, got spentBy=${utxoCheck.spentBy}`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Voiding consistency check failed:\n${errors.join('\n')}`);
  }
};

export const printVoidingConsistencyReport = (checks: VoidingConsistencyCheck): string => {
  let report = '=== Transaction Voiding Status ===\n';
  
  for (const txCheck of checks.transactionStatuses) {
    const status = txCheck.voided === txCheck.expected ? '✅' : '❌';
    report += `${status} ${txCheck.txId}: voided = ${txCheck.voided} (expected: ${txCheck.expected})\n`;
  }

  report += '\n=== UTXO Status ===\n';
  
  for (const utxoCheck of checks.utxoStatuses) {
    const voidedStatus = utxoCheck.voided === utxoCheck.expectedVoided ? '✅' : '❌';
    const spentByStatus = utxoCheck.spentBy === utxoCheck.expectedSpentBy ? '✅' : '❌';
    const voidedLabel = utxoCheck.voided ? 'VOIDED' : 'VALID';
    const spentByLabel = utxoCheck.spentBy ? `spent by ${utxoCheck.spentBy}` : 'unspent';
    
    report += `${voidedStatus}${spentByStatus} UTXO ${utxoCheck.txId}:${utxoCheck.index} = ${utxoCheck.value} HTR (${voidedLabel}, ${spentByLabel})\n`;
  }

  return report;
};