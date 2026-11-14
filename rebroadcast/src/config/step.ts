/**
 * One config step: the update that mirrors source config block `n` onto the destination's current config, who must
 * sign it, and the config it leads to. Shared by `plan` (offline, applied to the simulated config) and `run`
 * (submitted, then the committed config is checked against `next`).
 */
import { ConfigJson, Configtxlator } from './configtxlator';
import { appOrgs, applyUpdate, touchesOrdererOrChannel } from './chain';
import { transform } from './transform';
import { LoadedDescriptor } from '../descriptor';

export interface ConfigStep {
  sourceBlock: number;
  updateBytes: Buffer;
  update: ConfigJson;
  next: ConfigJson;
  /** Changed top-level groups, for the report. */
  changed: string[];
  /** MSP IDs whose signatures this update needs, in signing order (the first one submits). */
  signers: string[];
  /** True when the update has nothing to change (the source block changed only what the destination replaces). */
  empty: boolean;
}

export function configStep(
  ctl: Configtxlator,
  ld: LoadedDescriptor,
  channel: string,
  cur: ConfigJson,
  srcBlockBytes: Uint8Array,
  sourceBlock: number,
): ConfigStep {
  const target = transform(ctl.blockConfig(srcBlockBytes), cur, ld);
  const updateBytes = ctl.computeUpdate(channel, cur, target);
  if (!updateBytes.length) return { sourceBlock, updateBytes, update: null, next: cur, changed: [], signers: [], empty: true };
  const update = ctl.decode('common.ConfigUpdate', updateBytes);
  const next = applyUpdate(cur, update);
  // Signers: the source orgs already in the channel (an org not yet in it cannot authorise anything). On a provider,
  // until the first update, that is no source org at all: the platform's org signs alone.
  const here = new Set(appOrgs(cur));
  const present = Object.keys(ld.d.orgs).filter((m) => here.has(m));
  const signers = present.length ? present : ld.d.platform ? [ld.d.platform.msp] : [];
  const ordererMsp = ld.d.profile === 'provider' ? ld.d.platform?.msp : ld.d.ordererOrg?.msp;
  if (ordererMsp && touchesOrdererOrChannel(cur, update) && !signers.includes(ordererMsp)) signers.push(ordererMsp);
  return { sourceBlock, updateBytes, update, next, changed: Object.keys(update.write_set.groups ?? {}), signers, empty: false };
}
