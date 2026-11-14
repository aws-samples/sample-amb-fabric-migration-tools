import { ChannelFunctionMap } from '../types';

/**
 * Resolving a configured destination function to the call that reaches it.
 *
 * Two things stand between a config entry and a transaction. Which entry applies
 * is a question about `(channel, chaincode)`, because a chaincode name is only
 * unique within a channel. Which contract answers is a question about the entry's
 * value, because Fabric namespaces functions by contract within a chaincode and
 * both the migration contract and the customer's own contract live in the same
 * chaincode. `replay` used to answer the first with the chaincode alone and never
 * asked the second, so `"SampleAssets:StoreAsset"` was submitted as a function
 * name and rejected at the peer.
 */

/** The contract every unqualified function name is taken to belong to. */
export const DEFAULT_MIGRATION_CONTRACT = 'MigrationContract';

/** A `ContractName:FunctionName` config value, split into what to call. */
export interface QualifiedFunction {
  /** Contract namespace within the chaincode, for `network.getContract`. */
  contractName: string;
  /** Function to submit or evaluate, with no contract prefix. */
  functionName: string;
  /**
   * Whether `contractName` is the migration contract.
   *
   * Decides how a *read* payload is interpreted: the migration contract's read
   * functions return base64 (`sample/chaincode/migration_contract/README.md`),
   * while an application's own read function returns whatever it returns, so its
   * payload is the value bytes unchanged.
   */
  isMigrationContract: boolean;
}

/**
 * The function mapped to one chaincode on one source channel.
 *
 * @param map Function map from the chaincode replay config, possibly unset.
 * @param channel Source channel the record came from.
 * @param chaincode Source chaincode the record belongs to.
 * @returns The configured `ContractName:FunctionName`, or undefined if the pair
 *   has no entry.
 */
export function mappedFunction(
  map: ChannelFunctionMap | undefined,
  channel: string,
  chaincode: string,
): string | undefined {
  return map?.[channel]?.[chaincode];
}

/**
 * How many functions a map names in total, across every channel.
 *
 * Counting leaves rather than channels, because a map whose every channel entry
 * is empty — `{ "ch1": {} }` — names no function and must not read as configured.
 */
export function countFunctions(map: ChannelFunctionMap | undefined): number {
  return Object.values(map ?? {}).reduce(
    (total, byChaincode) => total + Object.keys(byChaincode).length,
    0,
  );
}

/**
 * Split a configured function into the contract that holds it and its name.
 *
 * A bare name means the migration contract, which is what makes the default
 * `PutState` work with no config at all. The split is on the *first* colon:
 * Fabric contract names cannot contain one, so anything after it belongs to the
 * function name.
 *
 * @param qualified Config value, `ContractName:FunctionName` or a bare name.
 * @param migrationContract Contract name an unqualified value resolves to.
 */
export function parseQualifiedFunction(
  qualified: string,
  migrationContract: string = DEFAULT_MIGRATION_CONTRACT,
): QualifiedFunction {
  const colonIdx = qualified.indexOf(':');
  if (colonIdx > 0) {
    const contractName = qualified.slice(0, colonIdx);
    return {
      contractName,
      functionName: qualified.slice(colonIdx + 1),
      isMigrationContract: contractName === migrationContract,
    };
  }
  return {
    contractName: migrationContract,
    functionName: qualified,
    isMigrationContract: true,
  };
}
