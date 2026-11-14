/**
 * Pre-flight probe confirming a destination migration contract implements the
 * resilient history-import protocol before the first write.
 *
 * `HistoryImportProtocol` is a read that names the protocol version the contract
 * implements. A contract that predates the protocol either has no such function
 * (the evaluate errors) or answers something that does not name the version.
 * Either way the run is refused up front rather than failing on the first
 * `ImportHistory`, which is a submit and would leave the destination touched.
 */
import { Contract } from '@hyperledger/fabric-gateway';
import { FN_PROTOCOL } from './protocol';

/** Bytes read back from the probe, truncated for a refusal message. */
const MAX_ANSWER_CHARS = 200;

/**
 * Probe one chaincode's migration contract.
 *
 * @param contract The migration contract on the destination chaincode.
 * @param mode The protocol version required, e.g. `idempotent-v1`.
 * @returns `null` when the contract implements the protocol, or a reason string.
 */
export async function probeHistoryImportProtocol(
  contract: Contract,
  mode: string,
): Promise<string | null> {
  let answer: Uint8Array;
  try {
    answer = await contract.evaluateTransaction(FN_PROTOCOL);
  } catch (err) {
    return (
      `${FN_PROTOCOL} did not answer (${(err as Error).message}) — the ` +
      'migration contract likely predates the resilient history-import protocol'
    );
  }

  const text = Buffer.from(answer).toString('utf-8');
  try {
    const descriptor = JSON.parse(text) as { protocol?: unknown };
    if (descriptor.protocol === mode) return null;
  } catch {
    // Refusal below includes the bounded answer for diagnosis.
  }
  return (
    `${FN_PROTOCOL} answered ${text.slice(0, MAX_ANSWER_CHARS)}, which does ` +
    `not declare the required protocol version ${mode}`
  );
}
