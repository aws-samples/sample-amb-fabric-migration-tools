import {
  DEFAULT_MIGRATION_CONTRACT,
  countFunctions,
  mappedFunction,
  parseQualifiedFunction,
} from '../src/replay/function-mapping';

// ── Which config entry applies ───
//
// Row 2.8. A chaincode name is only unique within a channel, so the same name on
// two of a large migration's eight channels is two deployments that can
// need two different destination functions. Looking one up by the chaincode
// alone — which `replay` used to do — gives them one entry.

describe('mappedFunction', () => {
  const map = {
    'orders-ch': { marketplace: 'PutState', ledger: 'ImportState' },
    'trades-ch': { marketplace: 'ImportLegacyState' },
  };

  it('resolves the entry for the channel the record came from', () => {
    expect(mappedFunction(map, 'orders-ch', 'marketplace')).toBe('PutState');
  });

  it('gives one chaincode name two functions on two channels', () => {
    expect(mappedFunction(map, 'trades-ch', 'marketplace'))
      .toBe('ImportLegacyState');
  });

  it('does not fall through to another channel\'s entry', () => {
    // `ledger` is mapped, but only on orders-ch.
    expect(mappedFunction(map, 'trades-ch', 'ledger')).toBeUndefined();
  });

  it('returns undefined for a channel the map does not name', () => {
    expect(mappedFunction(map, 'audit-ch', 'marketplace')).toBeUndefined();
  });

  it('returns undefined for an unset map', () => {
    expect(mappedFunction(undefined, 'orders-ch', 'marketplace'))
      .toBeUndefined();
  });
});

describe('countFunctions', () => {
  it('counts functions across every channel, not channels', () => {
    expect(countFunctions({
      ch1: { mycc: 'PutState', othercc: 'PutState' },
      ch2: { mycc: 'PutState' },
    })).toBe(3);
  });

  /**
   * A map whose channel entries are all empty names no function, so it must not
   * read as configured — otherwise `verify` accepts `{ "ch1": {} }` as a set of
   * read functions and then skips every record it was asked to check.
   */
  it('counts a map of empty channels as naming nothing', () => {
    expect(countFunctions({ ch1: {}, ch2: {} })).toBe(0);
  });

  it('counts an empty map and an unset map as naming nothing', () => {
    expect(countFunctions({})).toBe(0);
    expect(countFunctions(undefined)).toBe(0);
  });
});

// ── Which contract answers ───
//
// Fabric namespaces functions by contract within a chaincode, and the migration
// contract sits beside the customer's own in the same chaincode. `replay` never
// asked this question: it submitted `"SampleAssets:StoreAsset"` as a function
// name, which the peer rejects on every record.

describe('parseQualifiedFunction', () => {
  it('splits a qualified value into contract and function', () => {
    expect(parseQualifiedFunction('SampleAssets:StoreAsset')).toEqual({
      contractName: 'SampleAssets',
      functionName: 'StoreAsset',
      isMigrationContract: false,
    });
  });

  it('reads a bare name as the migration contract', () => {
    expect(parseQualifiedFunction('PutState')).toEqual({
      contractName: DEFAULT_MIGRATION_CONTRACT,
      functionName: 'PutState',
      isMigrationContract: true,
    });
  });

  it('recognises the migration contract when it is named explicitly', () => {
    const parsed = parseQualifiedFunction('MigrationContract:ReadState');
    expect(parsed.contractName).toBe('MigrationContract');
    expect(parsed.isMigrationContract).toBe(true);
  });

  /**
   * The flag decides how a *read* payload is interpreted — base64 from the
   * migration contract, raw bytes from anything else — so a renamed migration
   * contract has to be recognised by the configured name, not the default one.
   */
  it('recognises a renamed migration contract', () => {
    expect(parseQualifiedFunction('LedgerMigration:ReadState', 'LedgerMigration'))
      .toEqual({
        contractName: 'LedgerMigration',
        functionName: 'ReadState',
        isMigrationContract: true,
      });
    expect(
      parseQualifiedFunction('MigrationContract:ReadState', 'LedgerMigration')
        .isMigrationContract,
    ).toBe(false);
  });

  it('resolves a bare name to the configured migration contract', () => {
    expect(parseQualifiedFunction('PutState', 'LedgerMigration')).toEqual({
      contractName: 'LedgerMigration',
      functionName: 'PutState',
      isMigrationContract: true,
    });
  });

  /**
   * Split on the *first* colon: Fabric contract names cannot contain one, so
   * everything after it belongs to the function name. Splitting on the last
   * would take `A:B:C` to contract `A:B`, which no chaincode exposes.
   */
  it('splits on the first colon, leaving the rest to the function', () => {
    expect(parseQualifiedFunction('SampleAssets:Store:Asset')).toEqual({
      contractName: 'SampleAssets',
      functionName: 'Store:Asset',
      isMigrationContract: false,
    });
  });

  /**
   * A leading colon leaves no contract name. `getContract(cc, '')` is not the
   * default contract in fabric-gateway — it is a contract with an empty name, so
   * every call goes nowhere. Treating the value as a bare function name puts it
   * on the migration contract, which is where an unqualified name belongs.
   */
  it('treats a leading colon as an unqualified name', () => {
    expect(parseQualifiedFunction(':PutState')).toEqual({
      contractName: DEFAULT_MIGRATION_CONTRACT,
      functionName: ':PutState',
      isMigrationContract: true,
    });
  });
});
