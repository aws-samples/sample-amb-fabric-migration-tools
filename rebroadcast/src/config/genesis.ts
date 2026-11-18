// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `genesis` (self-managed only): the destination channel's block 0. The source's genesis config, transformed: its
 * orgs, policies and capabilities, the destination's Orderer group (from a configtxgen template block), and each source
 * org trusting the identity that signs as it. Join the destination's orderers to the channel with this block
 * (`osnadmin channel join`), then `run` from block 1.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { common } from '@hyperledger/fabric-protos';
import { Archive } from '../archive/reader';
import { Configtxlator } from './configtxlator';
import { transform } from './transform';
import { LoadedDescriptor } from '../descriptor';
import { Exit, RbError } from '../util/errors';

export function genesis(archive: Archive, ld: LoadedDescriptor, ctl: Configtxlator): Buffer {
  if (ld.d.profile !== 'self-managed') throw new RbError(Exit.Usage, '`genesis` is for self-managed destinations; a provider creates the channel itself');
  if (!ld.d.genesisTemplate) throw new RbError(Exit.Usage, 'the descriptor has no genesisTemplate (a configtxgen block for the destination channel)');
  const tmpl = ctl.decode('common.Block', fs.readFileSync(ld.p(ld.d.genesisTemplate)));
  const srcCfg = ctl.blockConfig(archive.raw(0));
  tmpl.data.data[0].payload.data.config = transform(srcCfg, tmpl.data.data[0].payload.data.config, ld);
  tmpl.data.data[0].payload.header.channel_header.channel_id = archive.channel;
  const blk = common.Block.deserializeBinary(ctl.encode('common.Block', tmpl));
  const data = blk.getData()!.getDataList_asU8();
  blk.getHeader()!.setDataHash(crypto.createHash('sha256').update(Buffer.concat(data.map((d) => Buffer.from(d)))).digest());
  return Buffer.from(blk.serializeBinary());
}
