import 'source-map-support/register';
import Joi from 'joi';

import { walletIdProxyHandler } from '@src/commons';
import { ApiError } from '@src/api/errors';
import {
  filterTxOutputs,
  getWalletAddresses,
  getTxOutput,
} from '@src/db';
import {
  DbTxOutput,
  DbTxOutputWithPath,
  IFilterTxOutput,
  AddressInfo,
} from '@src/types';
import { closeDbAndGetError } from '@src/api/utils';
import { getDbConnection } from '@src/utils';
import { constants, bigIntUtils, transactionUtils } from '@hathor/wallet-lib';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import errorHandler from '@src/api/middlewares/errorHandler';
import {
  getShieldedTxOutputDataByIds,
  getShieldedAddressInfoByAddresses,
  ShieldedTxOutputData,
  ShieldedAddressApiInfo,
} from '@src/db/shielded';
import { Bip32Account, RecoveryState, Severity, ShieldedOutputMode, isShieldedMode } from '@wallet-service/common';
import { addAlert } from '@wallet-service/common/src/utils/alerting.utils';
import createDefaultLogger from '@src/logger';

const mysql = getDbConnection();
const logger = createDefaultLogger();

const positiveBigInt = Joi.custom(value => {
  const newVal = BigInt(value);
  if (newVal > 0n) {
    return newVal;
  }
  throw new Error('value must be positive');
});

const bodySchema = Joi.object({
  id: Joi.string().optional(),
  addresses: Joi.array()
    .items(Joi.string().alphanum())
    .min(1)
    .optional(),
  tokenId: Joi.string().default('00'),
  authority: Joi.number().default(0).integer().positive(),
  ignoreLocked: Joi.boolean().optional(),
  // @ts-ignore : bigint is not considered a basic type for a default value.
  biggerThan: positiveBigInt.default(0n),
  // @ts-ignore
  smallerThan: positiveBigInt.default(constants.MAX_OUTPUT_VALUE + 1n),
  totalAmount: positiveBigInt.optional(),
  maxAmount: positiveBigInt.optional(),
  maxOutputs: Joi.number().integer().positive().default(constants.MAX_OUTPUTS),
  skipSpent: Joi.boolean().optional().default(true),
  txId: Joi.string().optional(),
  index: Joi.number().optional().min(0),
  kind: Joi.string().valid('transparent', 'shielded').optional(),
}).and('txId', 'index')
  .nand('totalAmount', 'maxAmount');

/*
 * Filter utxos
 *
 * This lambda is called by API Gateway on GET /wallet/utxos
 *
 * NOTICE: This method will be deprecated in the future, we are only keeping it because our deployed mobile wallet
 * uses it. As soon as it is updated and we are sure that no users are using that old version, we should remove this
 * API
 */
export const getFilteredUtxos = middy(walletIdProxyHandler(async (walletId, event) => {
  const multiQueryString = event.multiValueQueryStringParameters || {};
  const queryString = event.queryStringParameters || {};

  const eventBody = {
    id: queryString.id,
    addresses: multiQueryString['addresses[]'],
    tokenId: queryString.tokenId,
    authority: queryString.authority,
    ignoreLocked: queryString.ignoreLocked,
    biggerThan: queryString.biggerThan,
    smallerThan: queryString.smallerThan,
    skipSpent: true, // utxo is always unspent
    txId: queryString.txId,
    index: queryString.index,
    totalAmount: queryString.totalAmount,
    maxAmount: queryString.maxAmount,
    maxOutputs: queryString.maxOutputs,
    kind: queryString.kind,
  };

  const { value, error } = bodySchema.validate(eventBody, {
    abortEarly: false, // We want it to return all the errors not only the first
    convert: true, // We need to convert as parameters are sent on the QueryString
  });

  if (error) {
    const details = error.details.map((err) => ({
      message: err.message,
      path: err.path,
    }));

    return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, { details });
  }

  const response = await _getFilteredTxOutputs(walletId, value);

  // The /wallet/utxos API expects `utxos` on the response body, we should transform the
  // response accordingly
  if (response.statusCode === 200) {
    const body = bigIntUtils.JSONBigInt.parse(response.body);
    body.utxos = body.txOutputs;
    delete body.txOutputs;

    response.body = bigIntUtils.JSONBigInt.stringify(body);
  }

  return response;
})).use(cors())
  .use(errorHandler());

/*
 * Filter tx_outputs
 *
 * This lambda is called by API Gateway on GET /wallet/tx_outputs
 */
export const getFilteredTxOutputs = middy(walletIdProxyHandler(async (walletId, event) => {
  const multiQueryString = event.multiValueQueryStringParameters || {};
  const queryString = event.queryStringParameters || {};

  const eventBody = {
    id: queryString.id,
    addresses: multiQueryString['addresses[]'],
    tokenId: queryString.tokenId,
    authority: queryString.authority,
    ignoreLocked: queryString.ignoreLocked,
    biggerThan: queryString.biggerThan,
    smallerThan: queryString.smallerThan,
    skipSpent: queryString.skipSpent,
    txId: queryString.txId,
    index: queryString.index,
    totalAmount: queryString.totalAmount,
    maxAmount: queryString.maxAmount,
    maxOutputs: queryString.maxOutputs,
    kind: queryString.kind,
  };

  const { value, error } = bodySchema.validate(eventBody, {
    abortEarly: false, // We want it to return all the errors not only the first
    convert: true, // We need to convert as parameters are sent on the QueryString
  });

  if (error) {
    const details = error.details.map((err) => ({
      message: err.message,
      path: err.path,
    }));

    return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, { details });
  }

  return _getFilteredTxOutputs(walletId, value);
})).use(cors())
  .use(errorHandler());

const hydrateAndFormat = async (
  walletId: string,
  walletAddresses: AddressInfo[],
  txOutputs: DbTxOutput[],
): Promise<Record<string, unknown>[]> => {
  const withPath = mapTxOutputsWithPath(walletAddresses, txOutputs);
  const shielded = withPath.filter((output) => isShieldedMode(output.mode ?? 0));
  if (shielded.length === 0) {
    return formatTxOutputEntries(withPath, new Map(), new Map());
  }
  const satellite = await getShieldedTxOutputDataByIds(
    mysql,
    shielded.map((output) => ({ txId: output.txId, index: output.index })),
  );
  const shieldedAddresses = await getShieldedAddressInfoByAddresses(
    mysql,
    walletId,
    [...new Set(shielded.map((output) => output.address))],
  );
  return await formatTxOutputEntries(withPath, satellite, shieldedAddresses);
};

const _getFilteredTxOutputs = async (walletId: string, filters: IFilterTxOutput) => {
  const walletAddresses = await getWalletAddresses(mysql, walletId);

  // txId will only be on the body when the user is searching for specific tx outputs
  if (filters.txId !== undefined) {
    let txOutputList: Record<string, unknown>[] = [];
    const txOutput: DbTxOutput = await getTxOutput(mysql, filters.txId, filters.index, filters.skipSpent);

    if (txOutput) {
      // check if the utxo is a member of the user's wallet
      const denied = validateAddresses(walletAddresses, [txOutput.address]);

      if (denied.length > 0) {
        // the requested utxo does not belong to the user's wallet.
        return closeDbAndGetError(mysql, ApiError.TX_OUTPUT_NOT_IN_WALLET);
      }

      const isUnrecoveredShielded = isShieldedMode(txOutput.mode ?? 0)
        && txOutput.recoveryState !== RecoveryState.Recovered;

      const kindMismatch = (filters.kind === 'transparent' && isShieldedMode(txOutput.mode ?? 0))
        || (filters.kind === 'shielded' && !isShieldedMode(txOutput.mode ?? 0));

      if (!isUnrecoveredShielded && !kindMismatch) {
        txOutputList = await hydrateAndFormat(walletId, walletAddresses, [txOutput]);
      }
    }

    return {
      statusCode: 200,
      body: bigIntUtils.JSONBigInt.stringify({
        success: true,
        txOutputs: txOutputList,
      }),
    };
  }

  const newFilters = {
    ...filters,
  };

  if (newFilters.addresses) {
    const denied = validateAddresses(walletAddresses, newFilters.addresses);

    if (denied.length > 0) {
      return closeDbAndGetError(mysql, ApiError.ADDRESS_NOT_IN_WALLET, { missing: denied });
    }
  } else {
    newFilters.addresses = walletAddresses.map((addressInfo) => addressInfo.address);
  }

  const txOutputs: DbTxOutput[] = await filterTxOutputs(mysql, newFilters);
  let finalTxOutputs: DbTxOutput[] = txOutputs;

  // Apply totalAmount filter if specified (returns UTXOs summing to at least totalAmount)
  if (filters.totalAmount) {
    try {
      const minimalUtxos = txOutputs.map(tx => ({
        ...tx,
        authorities: BigInt(tx.authorities), // Convert for compatibility
        addressPath: '', // Required by type, but not used by selectUtxos algorithm
      }));

      const { utxos } = transactionUtils.selectUtxos(minimalUtxos, filters.totalAmount);

      // Filter original txOutputs to only include the selected ones
      const selectedSet = new Set(utxos.map(u => `${u.txId}:${u.index}`));
      finalTxOutputs = txOutputs.filter(tx => selectedSet.has(`${tx.txId}:${tx.index}`));
    } catch (error) {
      // If we don't have enough utxos, return empty array
      if (error.message && error.message.includes("Don't have enough utxos")) {
        finalTxOutputs = [];
      } else {
        throw error;
      }
    }
  }

  // Apply maxAmount filter if specified (returns UTXOs summing to at most maxAmount)
  if (filters.maxAmount) {
    let accumulatedAmount = 0n;
    const selectedTxOutputs: DbTxOutput[] = [];

    // txOutputs are sorted by value DESC from the database, so we iterate
    // from largest to smallest to minimize the number of UTXOs within the limit
    for (const txOutput of finalTxOutputs) {
      if (accumulatedAmount + txOutput.value <= filters.maxAmount) {
        selectedTxOutputs.push(txOutput);
        accumulatedAmount += txOutput.value;
      }
    }

    finalTxOutputs = selectedTxOutputs;
  }

  const txOutputsWithPath = await hydrateAndFormat(walletId, walletAddresses, finalTxOutputs);

  return {
    statusCode: 200,
    body: bigIntUtils.JSONBigInt.stringify({
      success: true,
      txOutputs: txOutputsWithPath,
    }),
  };
};

/**
 * Returns a new list of utxos with the addressPaths for each tx_output
 *
 * @param walletAddress - A list of addresses for the user's wallet
 * @param txOutputs - A list of txOutputs to map
 * @returns A list with the mapped tx_outputs
 */
export const mapTxOutputsWithPath = (walletAddresses: AddressInfo[], txOutputs: DbTxOutput[]): DbTxOutputWithPath[] => txOutputs.map((txOutput) => {
  const addressDetail: AddressInfo = walletAddresses.find((address) => address.address === txOutput.address);
  if (!addressDetail) {
    // this should never happen, so we will throw here
    throw new Error('Tx output address not in user\'s wallet');
  }
  const account = addressDetail.bip32Account === Bip32Account.CTSpend ? Bip32Account.CTSpend : Bip32Account.Legacy;
  const addressPath = `m/44'/${constants.HATHOR_BIP44_CODE}'/${account}'/0/${addressDetail.index}`;
  return { ...txOutput, addressPath };
});

/**
 * Attach the `kind` discriminator and, for shielded entries, the satellite
 * crypto bytes (hex) and CTSpend ownership metadata.
 *
 * The recovered-only filtering upstream means every shielded row here is
 * expected to have a satellite row and a claimed CTSpend address row, but a
 * miss can still happen (e.g. a partially-written recovery). When that
 * happens the offending entry is skipped and a MAJOR alert is raised instead
 * of failing the whole request — one invisible UTXO is a far smaller blast
 * radius than a 500 on the entire /utxos or /tx_outputs response, which
 * would otherwise also hide the wallet's unrelated transparent funds.
 */
export const formatTxOutputEntries = async (
  txOutputs: DbTxOutputWithPath[],
  satellite: Map<string, ShieldedTxOutputData>,
  shieldedAddresses: Map<string, ShieldedAddressApiInfo>,
): Promise<Record<string, unknown>[]> => {
  const entries: Record<string, unknown>[] = [];

  for (const txOutput of txOutputs) {
    if (!isShieldedMode(txOutput.mode ?? 0)) {
      entries.push({ ...txOutput, kind: 'transparent' });
      continue;
    }

    const data = satellite.get(`${txOutput.txId}:${txOutput.index}`);
    const addressInfo = shieldedAddresses.get(txOutput.address);

    const missing: string[] = [
      ...(!data ? ['satellite'] : []),
      ...(!addressInfo ? ['ownership'] : []),
    ];
    // A FullyShielded output requires both asset byte-fields; a present row with a
    // NULL required field would crash serialization, so it is a data-integrity
    // miss too and must degrade (skip + alert) rather than 500 the response.
    if (data && txOutput.mode === ShieldedOutputMode.FullyShielded) {
      if (data.assetCommitment === null) missing.push('asset_commitment');
      if (data.surjectionProof === null) missing.push('surjection_proof');
    }

    if (missing.length > 0) {
      await addAlert(
        'Shielded tx output missing satellite/ownership data',
        `tx_output ${txOutput.txId}:${txOutput.index} is missing its ${missing.join(', ')} data and was skipped.`,
        Severity.MAJOR,
        { txId: txOutput.txId, index: txOutput.index, missing },
        logger,
      );
      continue;
    }

    entries.push({
      ...txOutput,
      kind: 'shielded',
      ctAddress: addressInfo.ctAddress,
      shieldedIndex: addressInfo.shieldedIndex,
      commitment: data.commitment.toString('hex'),
      ephemeralPubkey: data.ephemeralPubkey.toString('hex'),
      rangeProof: data.rangeProof.toString('hex'),
      script: data.script.toString('hex'),
      ...(txOutput.mode === ShieldedOutputMode.AmountShielded ? { tokenData: data.tokenData } : {}),
      ...(txOutput.mode === ShieldedOutputMode.FullyShielded ? {
        assetCommitment: data.assetCommitment.toString('hex'),
        surjectionProof: data.surjectionProof.toString('hex'),
      } : {}),
    });
  }

  return entries;
};

/**
 * Confirm that the requested addresses belongs to the user's wallet
 *
 * @param walletAddresses - The user wallet id
 * @param addresses - List of addresses to validate
 * @returns A list with the denied addresses, if any
 */
export const validateAddresses = (walletAddresses: AddressInfo[], addresses: string[]): string[] => {
  const flatAddresses = walletAddresses.map((walletAddress) => walletAddress.address);
  const denied: string[] = [];

  for (let i = 0; i < addresses.length; i++) {
    if (!flatAddresses.includes(addresses[i])) {
      denied.push(addresses[i]);
    }
  }

  return denied;
};
