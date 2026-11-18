#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * fabric-rebroadcast: block-level migration of a Fabric channel to a Fabric 2.5 destination.
 * Every command takes --json (one JSON object on stdout, progress on stderr). No output carries a ledger value,
 * a private value or key material: block numbers, counts, transaction IDs, MSP IDs and digests only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { Archive } from '../archive/reader';
import { loadDescriptor } from '../descriptor';
import { openDestination, requirePeersCaughtUp } from '../destination';
import { Configtxlator } from '../config/configtxlator';
import { genesis } from '../config/genesis';
import { plan } from '../plan/plan';
import { run } from '../run/run';
import { compare } from '../compare/compare';
import { checkBundle, exportBundle, importSignatures, readBundle, sign, status } from '../ceremony/bundle';
import { identity } from '../config/signer';
import { probe } from '../plan/probe';
import { rebuildFacts } from '../verify/facts';
import { loadPrivate, privateInputMembers, verify } from '../verify/verify';
import { Endorser } from '../fabric/endorser';
import { endpointFrom } from '../orderer/client';
import { loadSigner } from '../descriptor';
import { tipConfig } from '../tip/tip';
import { archiveCollections, chaincodeCheck } from '../tip/chaincode';
import { importPrivate } from '../tip/import-private';
import { Exit, RbError } from '../util/errors';
import { durationMs, sha256 } from '../util/misc';
import { COMMANDS } from './commands';

const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { version: string }).version;


let json = false;
const log = (s: string): void => { (json ? process.stderr : process.stdout).write(s + '\n'); };
const emit = (o: unknown, human: () => void): void => { if (json) process.stdout.write(JSON.stringify(o, null, 2) + '\n'); else human(); };

async function main(): Promise<number> {
  const program = new Command('fabric-rebroadcast')
    .version(VERSION)
    .description('Re-broadcast a Fabric channel\'s original signed transactions, unchanged and in order, to a Fabric 2.5 destination')
    .option('--json', 'machine-readable output on stdout')
    .hook('preAction', (cmd) => { json = !!cmd.opts().json; });
  let code = Exit.Ok;

  program.command('check-archive <archive>')
    .description('verify an archive: sealed digests, data hashes, hash chain')
    .option('--channel <name>', 'channel subdirectory of an archive root')
    .action((dir: string, o: { channel?: string }) => {
      const a = new Archive(dir, o.channel);
      a.warnings.forEach((w) => log(`note: ${w}`));
      const n = a.verify();
      emit({ channel: a.channel, blocks: n, manifest: !!a.manifest, verified: true }, () => log(`archive ${a.channel}: ${n} blocks, digests, data hashes and hash chain verified`));
    });

  program.command('plan <archive>')
    .description('read-only preflight: block survey, signer expiry, config chain simulated offline, batch limits, estimate')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--channel <name>', 'channel')
    .option('--no-verify', 'skip the full archive verification')
    .option('--offline', 'self-managed only: do not contact the destination; start from the genesis `genesis` would write')
    .option('--at <date>', 'judge certificate expiry at this date (default: now)')
    .action(async (dir: string, o: { dest: string; channel: string; verify: boolean; offline?: boolean; at?: string }) => {
      const ld = loadDescriptor(o.dest);
      const a = new Archive(dir, o.channel);
      const dst = openDestination(ld, o.channel);
      try {
        const p = await plan(a, dst, { verify: o.verify, offline: o.offline, at: o.at, log });
        emit(p, () => {
          log(`plan for ${p.channel} (${p.profile}, ${p.mode}, BatchTimeout ${p.batchTimeout})`);
          log(`  archive: ${p.archive.blocks} blocks (${p.archive.configBlocks.length} config at ${p.archive.configBlocks.join(',')}), ${p.archive.transactions} transactions${p.archive.verified ? ', verified' : ''}`);
          log(`  largest: ${p.survey.maxTxPerBlock} txs in block ${p.survey.maxTxBlock}; ${p.survey.maxMultiTxBatchBytes} bytes in a multi-tx block; ${p.survey.maxEnvelopeBytes}-byte envelope`);
          log(`  signers: ${Object.entries(p.signers.creators).map(([m, c]) => `${m} ×${c}`).join(', ')}; earliest certificate expiry ${p.signers.earliestExpiry ?? 'n/a'}; expired ${p.signers.expiredAt.count}`);
          log(`  destination: ${p.destination.reachable ? `height ${p.destination.height}` : 'not contacted'}; first block to send ${p.destination.startsAt}`);
          if (p.destination.orderers) log(`  orderers: ${p.destination.orderers.map((o) => `${o.address} ${o.height ?? 'DOWN'}`).join(', ')}`);
          for (const s of p.configChain) log(`  config #${s.sourceBlock}: changes ${s.changed.join(',') || 'channel'}; signed by ${s.signers.join(', ')}`);
          log(`  estimate: ~${Math.round(p.estimate.seconds / 60)} min (${p.estimate.basis})`);
          for (const f of p.findings) log(`  ${f.level === 'blocking' ? 'BLOCKING' : 'note    '} [${f.id}] ${f.message}`);
          log(p.findings.some((f) => f.level === 'blocking') ? 'plan has blocking findings: run would fail or diverge' : 'plan OK');
        });
        if (p.findings.some((f) => f.level === 'blocking')) code = Exit.Blocking;
      } finally { dst.close(); }
    });

  program.command('genesis <archive>')
    .description('self-managed: write the destination channel\'s genesis block (join the orderers with it, then `run`)')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--out <file>', 'where to write the block')
    .option('--channel <name>', 'channel subdirectory of an archive root')
    .action((dir: string, o: { dest: string; out: string; channel?: string }) => {
      const ld = loadDescriptor(o.dest);
      const a = new Archive(dir, o.channel);
      const ctl = new Configtxlator(ld.d.configtxlator ? ld.p(ld.d.configtxlator.path) : 'configtxlator', ld.d.configtxlator?.sha256);
      const b = genesis(a, ld, ctl);
      fs.writeFileSync(o.out, b);
      emit({ channel: a.channel, out: path.resolve(o.out), sha256: sha256(b) }, () => log(`wrote ${o.out} (channel ${a.channel}, sha256 ${sha256(b).slice(0, 16)}…)`));
    });

  program.command('run <archive>')
    .description('PRODUCTION: re-broadcast the archive to the destination channel, block by block; the same command resumes')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--channel <name>', 'channel')
    .option('--to <n>', 'stop after this source block', (v) => parseInt(v, 10))
    .option('--window <n>', 'cut-markers: blocks sent ahead of the last verified', (v) => parseInt(v, 10), 32)
    .option('--bundle <dir>', 'a signed config bundle (sign-config): submit its updates and signatures unchanged')
    .option('--failover-quiet <duration>', 'after a failed send: how long nothing may be cut before the outcome is read (default max(2.5 × BatchTimeout, 10s))')
    .action(async (dir: string, o: { dest: string; channel: string; to?: number; window: number; bundle?: string; failoverQuiet?: string }) => {
      const ld = loadDescriptor(o.dest);
      const a = new Archive(dir, o.channel);
      a.warnings.forEach((w) => log(`note: ${w}`));
      const dst = openDestination(ld, o.channel);
      try {
        const s = await run(a, dst, { to: o.to, window: o.window, bundle: o.bundle, failoverQuietMs: o.failoverQuiet ? durationMs(o.failoverQuiet) : undefined, log });
        emit(s, () => {
          log(`done: ${s.blocksSent} blocks sent (${s.txBlocks} tx, ${s.configBlocks} config), each with the source block's transactions, in ${s.seconds.toFixed(1)} s; destination height ${s.endHeight}`);
          if (s.perTxBlockMs) log(`  per tx block p50 ${s.perTxBlockMs.p50} ms, p95 ${s.perTxBlockMs.p95} ms, max ${s.perTxBlockMs.max} ms; ingest p50 ${s.ingestMs!.p50} ms, max ${s.ingestMs!.max} ms; feed reconnects ${s.reconnects}`);
          for (const f of s.failovers) log(`  failover ${new Date(f.at).toISOString().slice(11, 19)} ${f.from} → ${f.to}: ${f.why}`);
        });
      } finally { dst.close(); }
    });

  program.command('compare <archive>')
    .description('read-only: compare the destination\'s blocks with the archive (via the orderer, or a peer for validation codes and commit hash)')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--channel <name>', 'channel')
    .option('--via <where>', '"orderer" or a peer index from the descriptor', 'orderer')
    .action(async (dir: string, o: { dest: string; channel: string; via: string }) => {
      const ld = loadDescriptor(o.dest);
      const a = new Archive(dir, o.channel);
      const dst = openDestination(ld, o.channel);
      try {
        const s = await compare(a, dst, o.via === 'orderer' ? 'orderer' : parseInt(o.via, 10), log);
        emit(s, () => {
          log(`compared ${s.compared} blocks via ${s.via} (${s.txBlocks} transaction, ${s.configBlocks} config): ${s.differ.length ? `${s.differ.length} DIFFER` : 'every transaction block matches the source (transactions, data hash' + (s.via === 'orderer' ? ')' : ', validation codes, commit hash)')}`);
          if (s.commitHashUnchecked) log(`  note: ${s.commitHashUnchecked} source transaction block(s) carry no commit hash (a ledger that started on a Fabric version without them); their commit hash was not compared`);
          for (const d of s.differ.slice(0, 20)) log(`  #${d.n}: ${d.why}`);
          if (s.destinationHeight < s.archiveHeight) log(`  INCOMPLETE: ${s.via} is at height ${s.destinationHeight}, the archive ${s.archiveHeight}; only the first ${s.compared} blocks were compared`);
          else if (s.destinationHeight > s.archiveHeight) log(`  note: destination height ${s.destinationHeight}, archive ${s.archiveHeight} (blocks after the archive are the destination's own)`);
        });
        if (s.differ.length) code = Exit.Mismatch;
        else if (s.destinationHeight < s.archiveHeight) code = Exit.Behind;
      } finally { dst.close(); }
    });

  program.command('verify <archive>')
    .description('read-only: the destination\'s state, deletes, keys, history and private hashes against the facts rebuilt from the archive (full, not sampled)')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--channel <name>', 'channel')
    .option('--peer <index>', 'peer index from the descriptor to query through', '0')
    .option('--private <path>', 'private values: this member\'s extraction directory (private-*-state.ndjson), a directory holding several members\' extractions, or an ndjson of {chaincode, collection, key, value(base64)}')
    .option('--hash-only <collections>', 'comma-separated collections (or chaincode/collection) to check by hash only')
    .option('--accept-unchecked <collections>', 'comma-separated collections (or chaincode/collection), or "all": live private keys the data owners accepted cannot be checked; reported, not failed')
    .option('--concurrency <n>', 'parallel queries', (v) => parseInt(v, 10), 8)
    .option('--show-values', 'print values in failures (default: hashes only)')
    .action(async (dir: string, o: { dest: string; channel: string; peer: string; private?: string; hashOnly?: string; acceptUnchecked?: string; concurrency: number; showValues?: boolean }) => {
      const ld = loadDescriptor(o.dest);
      const pe = ld.d.peers?.[parseInt(o.peer, 10)];
      if (!pe) throw new RbError(Exit.Usage, `the descriptor has no peers[${o.peer}]`);
      const a = new Archive(dir, o.channel);
      const t0 = Date.now();
      const facts = rebuildFacts(a);
      const nk = (m: Map<string, Map<string, unknown>>): number => [...m.values()].reduce((s, x) => s + x.size, 0);
      log(`facts from ${a.height} blocks: ${facts.validTxs} valid txs (${facts.skippedTxs} not valid, skipped); ${nk(facts.state)} public keys in ${facts.state.size} namespaces; ${nk(facts.privateHashes)} live private hashes in ${facts.privateHashes.size} collections (${Date.now() - t0} ms)`);
      const priv = o.private ? loadPrivate(o.private, o.channel) : undefined;
      const members = o.private ? privateInputMembers(o.private, o.channel) : undefined;
      const collections = archiveCollections(a);
      const dstv = openDestination(ld, o.channel);
      try { await requirePeersCaughtUp(dstv, [parseInt(o.peer, 10)]); } finally { dstv.close(); }
      const e = new Endorser(endpointFrom(pe, ld.p), o.channel, loadSigner(ld, pe.reader, pe.reader.msp));
      try {
        const r = await verify(facts, e, {
          channel: o.channel, concurrency: o.concurrency, priv, hashOnly: o.hashOnly?.split(',').filter(Boolean), showValues: o.showValues, log,
          collections, members, sourceOrgs: Object.keys(ld.d.orgs), acceptUnchecked: o.acceptUnchecked?.split(',').filter(Boolean),
        });
        emit(r, () => {
          log(`verify ${r.channel} via ${pe.address} as ${r.peerMsp}: ${r.ok ? 'ALL MATCH' : 'DIFFERENCES'}`);
          log(`  live state ${r.state.ok}/${r.state.live} match (${r.state.differ} differ, ${r.state.missing} missing)${r.state.jsonNormalized ? `; ${r.state.jsonNormalized} equal as JSON only (the state database re-serialised them)` : ''}`);
          log(`  deleted at source ${r.deletes.absent}/${r.deletes.total} absent`);
          log(`  key sweep: ${r.sweep.listed} listed in ${r.sweep.namespaces} namespaces; extra ${r.sweep.extra}, missing ${r.sweep.missing}`);
          log(`  history ${r.history.ok}/${r.history.keys} keys (${r.history.versions} versions) match; order: newest-first ${r.history.order.newestFirst}, oldest-first ${r.history.order.oldestFirst}, single version ${r.history.order.single}`);
          if (r.private) {
            const p = r.private;
            log(`  private, for ${p.members === 'all' ? 'every member (a merged input, or no input from a source org)' : p.members.join(', ')}: ${p.records} records; hash ${p.hashOk} match, ${p.hashBad} differ; value ${p.valueOk} match, ${p.valueBad} missing or differ; hash-only ${p.hashOnly}; input disagrees with blocks ${p.inputDisagrees}`);
            log(`    live keys with no value supplied: ${p.uncheckedLiveKeys} (${p.uncheckedInScope} fail this run); purged at source by blockToLive: ${p.expiredAtSource}${p.accepted.length ? `; accepted unchecked: ${p.accepted.join(', ')}` : ''}`);
            for (const [g, s] of Object.entries(p.perCollection).sort()) log(`    ${g}: hash ${s.hash}, value ${s.value}, hash-only ${s.hashOnly}, bad ${s.bad}, unchecked ${s.unchecked}${s.accepted && s.unchecked ? ' (accepted)' : ''}, expired ${s.expired} | live at source ${s.liveAtSource}; read by ${s.readers.join(', ') || '?'}`);
            const rest = Object.entries(p.toVerifyBy).sort();
            if (rest.length) {
              log('  still to verify, by each member with its own extraction:');
              for (const [m, gs] of rest) log(`    ${m}: ${gs.join(', ')}`);
            }
          }
          log(`  query errors ${r.queryErrors}`);
          for (const f of r.failures.slice(0, 25)) log(`  ${f}`);
        });
        if (!r.ok) code = Exit.Mismatch;
      } finally { e.close(); }
    });

  const tip = program.command('tip').description('after run: hand the channel back to the destination');
  tip.command('config')
    .description('GATED (provider): add the platform org back and restore its Admins/LifecycleEndorsement, Endorsement ANY; without --yes: show the change')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--channel <name>', 'channel')
    .option('--yes', 'sign and submit the update')
    .action(async (o: { dest: string; channel: string; yes?: boolean }) => {
      const dst = openDestination(loadDescriptor(o.dest), o.channel);
      try {
        const r = await tipConfig(dst, { yes: !!o.yes, log });
        emit(r, () => {
          if (r.alreadyDone) { log(`tip config on ${r.channel}: nothing to change (${r.platform} already restored)`); return; }
          log(`tip config on ${r.channel}: ${r.applied ? `APPLIED in config block ${r.configBlock}` : 'would change'}; signed by ${r.signers.join(', ')}`);
          for (const c of r.changes) log(`  ${c}`);
          if (!r.applied) log('rerun with --yes to sign and submit');
        });
      } finally { dst.close(); }
    });

  const peerEndorser = (ld: ReturnType<typeof loadDescriptor>, i: number, channel: string): Endorser => {
    const pe = ld.d.peers?.[i];
    if (!pe) throw new RbError(Exit.Usage, `the descriptor has no peers[${i}]`);
    return new Endorser(endpointFrom(pe, ld.p), channel, loadSigner(ld, pe.reader, pe.reader.msp));
  };

  tip.command('chaincode-check <archive>')
    .description('read-only: per chaincode, the source definition vs the destination\'s, migration contract, collection/endorsement policies; prints the lifecycle commands')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--channel <name>', 'channel')
    .option('--peer <index>', 'peer index from the descriptor (its reader should be the peer org\'s admin to list installed packages)', '0')
    .option('--write-collections <dir>', 'write the collection config files the printed commands name')
    .action(async (dir: string, o: { dest: string; channel: string; peer: string; writeCollections?: string }) => {
      const ld = loadDescriptor(o.dest);
      const a = new Archive(dir, o.channel);
      const dst = openDestination(ld, o.channel);
      const e = peerEndorser(ld, parseInt(o.peer, 10), o.channel);
      try {
        await requirePeersCaughtUp(dst, [parseInt(o.peer, 10)]);
        const r = await chaincodeCheck(a, dst, e, { writeCollections: o.writeCollections, log });
        emit(r, () => {
          log(`chaincode check on ${r.channel} (${ld.d.profile}): ${r.chaincodes.length} chaincode(s) defined in the archive`);
          for (const c of r.chaincodes) {
            log(`  ${c.name}: ${c.state.toUpperCase()} | source v${c.source.version} seq ${c.source.sequence}${c.source.block !== undefined ? ` (block ${c.source.block})` : ''}, endorsement ${c.source.endorsement.text || c.source.endorsement.kind}, collections ${c.source.collections.map((x) => x.name).join(', ') || '-'} | destination ${c.destination ? `v${c.destination.version} seq ${c.destination.sequence}` : 'none'}${c.contractAnswers === 'not-checked' ? '' : `, migration contract ${c.contractAnswers ? 'answers' : 'DOES NOT answer'}`}`);
            for (const x of c.issues) log(`      ! ${x}`);
            for (const x of c.notes) log(`      - ${x}`);
            if (c.commands.length) { log(`      run (as the destination org's admin):`); for (const x of c.commands) log(`        ${x}`); }
            if (c.collectionsFile) log(`      collections: ${c.collectionsFile}${o.writeCollections ? ' (written)' : ' (not written: add --write-collections <dir>)'}`);
          }
          log(`  installed on the peer: ${Array.isArray(r.installed) ? r.installed.join(', ') || 'none' : r.installed}`);
        });
        if (r.chaincodes.some((c) => c.state !== 'ready')) code = Exit.Blocking;
      } finally { e.close(); dst.close(); }
    });

  tip.command('import-private <archive>')
    .description('GATED: write private values back through the migration contract (ImportPrivateDataBatch); without --yes: the plan')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--channel <name>', 'channel')
    .requiredOption('--private <path>', 'an extraction directory (private-*-state.ndjson) or an ndjson of {chaincode, collection, key, value(base64)}')
    .option('--peers <indexes>', 'endorsing peers (descriptor indexes); the first one\'s reader is the writer and its chain is watched for commits', '0')
    .option('--batch <n>', 'keys per transaction', (v) => parseInt(v, 10), 25)
    .option('--concurrency <n>', 'parallel hash checks', (v) => parseInt(v, 10), 8)
    .option('--yes', 'write')
    .action(async (dir: string, o: { dest: string; channel: string; private: string; peers: string; batch: number; concurrency: number; yes?: boolean }) => {
      const ld = loadDescriptor(o.dest);
      const a = new Archive(dir, o.channel);
      const dst = openDestination(ld, o.channel);
      const idx = o.peers.split(',').map((x) => parseInt(x, 10));
      const es = idx.map((i) => peerEndorser(ld, i, o.channel));
      try {
        await requirePeersCaughtUp(dst, idx);
        const recs = loadPrivate(o.private, o.channel);
        const r = await importPrivate(a, dst, es, dst.peers[idx[0]], recs, { yes: !!o.yes, batch: o.batch, concurrency: o.concurrency, log });
        emit(r, () => {
          log(`import-private on ${r.channel} as ${r.writer} via ${r.endorsers.join(', ')}: ${r.applied ? `${r.written} keys written in ${r.txs} txs` : 'plan only'}`);
          for (const g of r.groups) log(`  ${g.group}${g.blockToLive ? ` (blockToLive ${g.blockToLive})` : ''}: ${g.records} records; ${g.present} already present; ${g.skipped ? `SKIPPED: ${g.skipped}` : r.applied ? `${g.written}/${g.toWrite} written${g.failed ? ` | STOPPED: ${g.failed}` : ''}` : `${g.toWrite} to write`}`);
          if (!r.applied) log('rerun with --yes to write');
        });
        if (r.groups.some((g) => g.failed)) code = Exit.Rejected;
        else if (r.groups.some((g) => g.skipped)) code = Exit.Blocking;
      } finally { es.forEach((e) => e.close()); dst.close(); }
    });

  const sc = program.command('sign-config').description('the config-signing ceremony: export a bundle, each member signs it with its own key, import, verify');
  sc.command('export <archive>')
    .description('compute every config update offline and write a bundle to sign')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--channel <name>', 'channel')
    .requiredOption('--out <dir>', 'an empty directory for the bundle')
    .option('--offline', 'self-managed only: start from the genesis `genesis` would write, without contacting the destination')
    .action(async (dir: string, o: { dest: string; channel: string; out: string; offline?: boolean }) => {
      const ld = loadDescriptor(o.dest);
      const a = new Archive(dir, o.channel);
      const dst = openDestination(ld, o.channel);
      try {
        const b = await exportBundle(a, dst, o.out, { offline: o.offline, log });
        emit(b, () => {
          log(`bundle for ${b.channel} written to ${o.out}: ${b.steps.length} config updates, ${b.steps.reduce((x, s) => x + s.signers.length, 0)} signatures to collect`);
          const by = new Map<string, number[]>();
          for (const s of b.steps) for (const m of s.signers) by.set(m, [...(by.get(m) ?? []), s.sourceBlock]);
          for (const [m, ns] of by) log(`  ${m} signs ${ns.length}: blocks ${ns.join(', ')}`);
        });
      } finally { dst.close(); }
    });
  sc.command('sign <bundle>')
    .description('sign every update in the bundle that needs this org, with this org\'s key; checks the bundle first')
    .requiredOption('--msp <id>', 'the MSP ID to sign as')
    .requiredOption('--cert <file>', 'the admin certificate')
    .requiredOption('--key <file>', 'its private key (read locally, never written anywhere)')
    .option('--configtxlator <path>', 'configtxlator binary', 'configtxlator')
    .option('--yes', 'write the signatures (without it: show what would be signed)')
    .action((dir: string, o: { msp: string; cert: string; key: string; configtxlator: string; yes?: boolean }) => {
      const b = readBundle(dir);
      const summary = checkBundle(dir, b, new Configtxlator(o.configtxlator));
      const id = identity(o.msp, o.cert, o.key);
      const mine = b.steps.filter((s) => s.signers.includes(o.msp));
      if (!mine.length) throw new RbError(Exit.Usage, `no update in this bundle needs a signature from ${o.msp}`);
      const done = sign(dir, b, id, !!o.yes);
      emit({ channel: b.channel, mspId: o.msp, written: !!o.yes, steps: mine.map((s) => ({ sourceBlock: s.sourceBlock, updateSha256: s.updateSha256, changes: summary.get(s.sourceBlock) })), files: done.map((d) => d.file) }, () => {
        log(`${o.msp} ${o.yes ? 'signed' : 'would sign'} ${mine.length} update(s) of channel ${b.channel}; every update was decoded and re-applied, and does what is listed:`);
        for (const s of mine) { log(`  block ${s.sourceBlock} (update ${s.updateSha256.slice(0, 16)}…):`); for (const c of summary.get(s.sourceBlock)!) log(`      ${c}`); }
        if (!o.yes) log('nothing written: rerun with --yes to sign');
      });
    });
  sc.command('import <bundle> <signatures...>')
    .description('copy signature files or directories into the bundle; each must verify')
    .action((dir: string, srcs: string[]) => {
      const b = readBundle(dir);
      const r = importSignatures(dir, b, srcs);
      emit(r, () => { log(`imported ${r.imported.length} signature(s)`); for (const x of r.refused) log(`  REFUSED ${x.file}: ${x.why}`); });
      if (r.refused.length) code = Exit.SignaturesMissing;
    });
  sc.command('verify <bundle>')
    .description('per update: signatures present, valid and accepted by the config they apply to')
    .option('--configtxlator <path>', 'also check every update does what the bundle says (needs configtxlator)')
    .action((dir: string, o: { configtxlator?: string }) => {
      const b = readBundle(dir);
      if (o.configtxlator) checkBundle(dir, b, new Configtxlator(o.configtxlator));
      const st = status(dir, b);
      const incomplete = st.filter((s) => s.missing.length || s.invalid.length);
      emit({ channel: b.channel, steps: st, complete: !incomplete.length }, () => {
        for (const s of st) log(`  block ${s.sourceBlock}: ${s.valid.length}/${s.needs.length} valid${s.missing.length ? `; missing ${s.missing.join(', ')}` : ''}${s.invalid.length ? `; INVALID ${s.invalid.map((x) => `${x.mspId} (${x.why})`).join(', ')}` : ''}`);
        log(incomplete.length ? `incomplete: ${incomplete.length} of ${st.length} updates lack signatures` : `complete: all ${st.length} updates fully signed`);
      });
      if (incomplete.length) code = Exit.SignaturesMissing;
    });

  program.command('probe <archive>')
    .description('SCRATCH-CHANNEL WRITES: measure ingest time for bursts shaped like the archive\'s largest blocks; recommends a BatchTimeout')
    .requiredOption('--dest <descriptor>', 'destination descriptor')
    .requiredOption('--scratch <channel>', 'a throwaway channel on the destination (never the migration channel)')
    .option('--bursts <n>', 'number of bursts', (v) => parseInt(v, 10), 30)
    .option('--channel <name>', 'channel subdirectory of an archive root')
    .action(async (dir: string, o: { dest: string; scratch: string; bursts: number; channel?: string }) => {
      const ld = loadDescriptor(o.dest);
      const a = new Archive(dir, o.channel);
      if (o.scratch === a.channel) throw new RbError(Exit.Usage, `--scratch must not be the migration channel (${a.channel}): probe writes filler transactions`);
      const dst = openDestination(ld, o.scratch);
      try {
        const r = await probe(a, dst, { bursts: o.bursts, log });
        emit(r, () => {
          log(`probe on ${r.scratch} at BatchTimeout ${r.batchTimeout}: ${r.bursts} bursts (largest ${Math.max(...r.shapes.map((s) => s.txs))} txs, ${Math.max(...r.shapes.map((s) => s.bytes))} bytes)`);
          log(`  ingest p50 ${r.ingestMs.p50} ms, p95 ${r.ingestMs.p95} ms, p99 ${r.ingestMs.p99} ms, max ${r.ingestMs.max} ms; splits ${r.splits}`);
          log(`  recommended BatchTimeout ${r.recommendedBatchTimeout}`);
          log(`  ${r.note}`);
        });
        if (r.splits) code = Exit.Blocking;
      } finally { dst.close(); }
    });

  program.command('commands')
    .description('list every command with its class and what it reads and writes')
    .action(() => emit(COMMANDS, () => COMMANDS.forEach((c) => log(`${c.name.padEnd(14)} ${c.class.padEnd(11)} writes: ${c.writes.join(', ') || '-'}`))));

  await program.parseAsync(process.argv);
  return code;
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    if (e instanceof RbError) {
      if (json) process.stdout.write(JSON.stringify({ error: e.message, exitCode: e.code }) + '\n');
      process.stderr.write(`STOP (exit ${e.code}): ${e.message}\n`);
      process.exit(e.code);
    }
    process.stderr.write(`error: ${(e as Error).stack ?? e}\n`);
    process.exit(Exit.Usage);
  },
);
