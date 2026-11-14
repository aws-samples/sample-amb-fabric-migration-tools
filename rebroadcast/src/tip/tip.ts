/**
 * `tip config` (design §9), provider profile: after the whole archive is replayed, the channel's Application group is
 * the SOURCE's, so the platform's own org is gone and the platform can no longer manage the channel or run lifecycle.
 * This one config update gives it back: the platform org (as the platform created it, block 0), Application `Admins`
 * and `LifecycleEndorsement` as the platform had them, and `Endorsement` = ANY (the source orgs have no peers here, so
 * MAJORITY could never be met). It is made under the replayed Admins policy, so the source orgs sign it.
 * Without `yes` it only reports what would change.
 */
import { Destination, liveConfig, reachableHeight } from '../destination';
import { appOrgs, applyUpdate, firstDiff } from '../config/chain';
import { ConfigJson } from '../config/configtxlator';
import { configSignature, configUpdateEnvelope } from '../config/signer';
import { describeChange } from '../ceremony/bundle';
import { decodeBlock } from '../fabric/blocks';
import { clone } from '../util/misc';
import { Exit, RbError } from '../util/errors';

export interface TipResult { channel: string; platform: string; changes: string[]; signers: string[]; applied: boolean; configBlock?: number; alreadyDone: boolean }

export function tipTarget(cur: ConfigJson, original: ConfigJson, platformMsp: string): ConfigJson {
  const o = original.channel_group.groups.Application;
  if (!o.groups[platformMsp]) throw new RbError(Exit.Usage, `the destination's block 0 has no Application org ${platformMsp}: is platform.msp right?`);
  const t = clone(cur);
  const a = t.channel_group.groups.Application;
  a.groups[platformMsp] = clone(o.groups[platformMsp]);
  a.policies.Admins = clone(o.policies.Admins);
  if (o.policies.LifecycleEndorsement) a.policies.LifecycleEndorsement = clone(o.policies.LifecycleEndorsement);
  a.policies.Endorsement = { mod_policy: a.policies.Endorsement?.mod_policy ?? 'Admins', policy: { type: 3, value: { rule: 'ANY', sub_policy: 'Endorsement' } } };
  return t;
}

export async function tipConfig(dst: Destination, opts: { yes: boolean; log: (s: string) => void }): Promise<TipResult> {
  const { ld, channel, orderer, ctl } = dst;
  if (ld.d.profile !== 'provider' || !ld.d.platform) throw new RbError(Exit.Usage, 'tip config is for a provider destination: a self-managed destination already is the source orgs');
  const plat = ld.d.platform.msp;
  const height = await reachableHeight(dst);
  const original = ctl.blockConfig(await orderer.fetch(0));
  const { config: cur } = await liveConfig(dst);
  const target = tipTarget(cur, original, plat);
  const base: TipResult = { channel, platform: plat, changes: describeChange(cur, target), signers: [], applied: false, alreadyDone: false };
  const upd = ctl.computeUpdate(channel, cur, target);
  if (!upd.length) return { ...base, alreadyDone: true };

  // Under the replayed Admins policy: the source orgs in the channel sign, the first submits.
  const here = appOrgs(cur).filter((m) => m !== plat);
  const missing = here.filter((m) => !dst.orgSigners.has(m));
  if (missing.length) throw new RbError(Exit.SignaturesMissing, `tip config needs a signature from every source org in the channel; no local signer for ${missing.join(', ')} (a ceremony for tip is not built yet)`);
  const signers = here.map((m) => dst.orgSigners.get(m)!);
  const r = { ...base, signers: here };
  if (!opts.yes) return r;

  const feed = orderer.feed(height);
  try {
    const [v] = await orderer.broadcast([configUpdateEnvelope(signers[0], channel, upd, signers.map((s) => configSignature(s, upd)))]);
    if (v.status !== 'SUCCESS') throw new RbError(Exit.Rejected, `the orderer refused the tip update: ${v.status} ${v.info}`);
    const b = decodeBlock((await feed.get(height, 60000)).bytes);
    if (!b.isConfig) throw new RbError(Exit.Mismatch, `block ${height} after the tip update is not a config block`);
    const d = firstDiff(ctl.blockConfig(b.bytes), applyUpdate(cur, ctl.decode('common.ConfigUpdate', upd)));
    if (d) throw new RbError(Exit.Mismatch, `the committed config differs from the one computed, at ${d}`);
    opts.log(`config block ${height}: ${plat} is an Application org again`);
    return { ...r, applied: true, configBlock: height };
  } finally {
    feed.close();
  }
}
