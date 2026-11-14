/**
 * Minimal abstraction over Fabric SDK Network/Contract objects.
 *
 * Both `@hyperledger/fabric-gateway` (2.4+) and `fabric-network` (1.4–2.x)
 * expose getContract/evaluateTransaction/submitTransaction, but with different
 * concrete types. This interface captures the shared surface used by all
 * extraction and discovery code, allowing the same consumers to work against
 * either SDK.
 *
 * The replay path (ChaincodeAdapter) is intentionally NOT abstracted here
 * because it uses `contract.newProposal()` which is gateway-SDK-only and
 * always targets a modern destination network.
 */

export interface ContractAdapter {
  evaluateTransaction(name: string, ...args: (string | Uint8Array)[]): Promise<Uint8Array>;
  submitTransaction(name: string, ...args: (string | Uint8Array)[]): Promise<Uint8Array>;
}

export interface NetworkAdapter {
  getContract(chaincodeName: string): ContractAdapter;
}
