/**
 * Where the config chain starts: the destination's live config, or — self-managed, offline — the genesis config
 * `genesis` would write for this archive (round-tripped through configtxlator, so it has the shape the orderer's
 * own copy will have).
 */
import * as fs from 'fs';
import { Archive } from '../archive/reader';
import { ConfigJson } from '../config/configtxlator';
import { appOrgs } from '../config/chain';
import { transform } from '../config/transform';
import { Destination, liveConfig, reachableHeight } from '../destination';
import { Exit, RbError } from '../util/errors';

export interface ChainStart { start: ConfigJson; startsAt: number; height?: number; started: boolean }

export async function chainStart(archive: Archive, dst: Destination, offline: boolean): Promise<ChainStart> {
  const { ld, ctl } = dst;
  if (offline) {
    if (ld.d.profile !== 'self-managed' || !ld.d.genesisTemplate) throw new RbError(Exit.Usage, '--offline needs a self-managed descriptor with genesisTemplate (a provider chain starts from the platform\'s own config)');
    const tmplCfg = ctl.blockConfig(fs.readFileSync(ld.p(ld.d.genesisTemplate)));
    const start = ctl.decode('common.Config', ctl.encode('common.Config', transform(ctl.blockConfig(archive.raw(0)), tmplCfg, ld)));
    return { start, startsAt: 1, started: true };
  }
  const height = await reachableHeight(dst);
  const start = (await liveConfig(dst)).config;
  return { start, startsAt: height, height, started: appOrgs(start).some((m) => m in ld.d.orgs) };
}
