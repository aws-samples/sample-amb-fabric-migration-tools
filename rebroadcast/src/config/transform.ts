// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Source channel config → destination channel config.
 *
 * Everything that is the source's stays the source's: application orgs, their MSP IDs, policies, ACLs, capabilities
 * (except on a provider, where the platform's own level is kept: a capability cannot be lowered). What is the
 * destination's replaces it: the Orderer group and orderer addresses. Each source org additionally trusts the
 * destination identity that signs as it (its root CA, TLS root CA and admin certificate), and NodeOU identifiers are
 * unpinned so they apply under every root (migration doc F6).
 */
import * as fs from 'fs';
import { ConfigJson } from './configtxlator';
import { clone } from '../util/misc';
import { LoadedDescriptor } from '../descriptor';
import { Exit, RbError } from '../util/errors';

const b64 = (f: string): string => fs.readFileSync(f).toString('base64');

export function transform(srcCfg: ConfigJson, dstCfg: ConfigJson, ld: LoadedDescriptor): ConfigJson {
  const { d, p } = ld;
  const out = clone(srcCfg);
  const cg = out.channel_group;
  cg.groups.Orderer = clone(dstCfg.channel_group.groups.Orderer);
  if (dstCfg.channel_group.values.OrdererAddresses) cg.values.OrdererAddresses = clone(dstCfg.channel_group.values.OrdererAddresses);
  else delete cg.values.OrdererAddresses;
  delete cg.groups.Consortiums;
  if (d.profile === 'provider') {
    cg.groups.Application.values.Capabilities = clone(dstCfg.channel_group.groups.Application.values.Capabilities);
    if (dstCfg.channel_group.values.Capabilities) cg.values.Capabilities = clone(dstCfg.channel_group.values.Capabilities);
  }
  const ov = d.ordererOverrides ?? {};
  const ord = cg.groups.Orderer.values;
  if (ov.BatchTimeout) ord.BatchTimeout.value.timeout = ov.BatchTimeout;
  if (ov.BatchSize) Object.assign(ord.BatchSize.value, ov.BatchSize);
  for (const [name, g] of Object.entries(cg.groups.Application.groups as Record<string, ConfigJson>)) {
    const mspCfg = g.values.MSP.value.config;
    const o = d.orgs[mspCfg.name];
    if (!o) throw new RbError(Exit.Blocking, `the descriptor has no entry under "orgs" for source MSP ${mspCfg.name} (group ${name})`);
    const add = (list: string[] | undefined, v: string): string[] => ((list ?? []).includes(v) ? list! : [...(list ?? []), v]);
    mspCfg.root_certs = add(mspCfg.root_certs, b64(p(o.rootCa)));
    mspCfg.tls_root_certs = add(mspCfg.tls_root_certs, b64(p(o.tlsRootCa)));
    if ((mspCfg.admins ?? []).length) mspCfg.admins = add(mspCfg.admins, b64(p(o.signer.cert)));
    const ous = mspCfg.fabric_node_ous;
    if (ous && ous.enable) {
      for (const k of ['client_ou_identifier', 'peer_ou_identifier', 'admin_ou_identifier', 'orderer_ou_identifier']) if (ous[k]) delete ous[k].certificate;
    }
    // The value must stay when the source has one (a later source block may change it); its content is the destination's.
    if (g.values.AnchorPeers) g.values.AnchorPeers.value.anchor_peers = d.profile === 'provider' ? [] : (o.anchorPeers ?? []);
  }
  return out;
}
