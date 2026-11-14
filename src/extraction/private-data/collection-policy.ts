/**
 * True if a collection policy names the given MSP as a member.
 *
 * Policies are signature policies rendered as strings by the discoverer, for
 * example `OR('Org1MSP.member', 'Org2MSP.peer')`. Membership is the criterion
 * that matters: a peer only delivers private data values for collections the
 * connected MSP belongs to.
 *
 * Fails open. An empty or unparseable policy returns true so that a policy we
 * cannot read is never reported as the reason data is missing — blaming the
 * wrong cause is worse than declining to name one.
 *
 * @param policy Rendered signature policy, or an empty string if unknown.
 * @param mspId MSP ID of the identity that performed the extraction.
 */
export function collectionPolicyIncludes(
  policy: string,
  mspId: string,
): boolean {
  if (!policy || policy.includes("'unknown'")) return true;
  const tokens = [...policy.matchAll(/'([^'.]+)\.[A-Za-z]+'/g)];
  if (tokens.length === 0) return true;
  return tokens.some((match) => match[1] === mspId);
}
