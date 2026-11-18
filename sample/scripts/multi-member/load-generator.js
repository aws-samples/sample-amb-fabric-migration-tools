#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/*
 * Multi-member load generator for the live migration test.
 *
 * Drives a realistic, deep ledger across every channel the harness created:
 * each member submits as itself through its own peer, so creators, endorsers
 * and private-data owners vary the way they do on a real consortium.
 *
 * AMB 2.2 has no Gateway service, so this talks fabric-common directly — the
 * same one-way-TLS client the extractor uses — and broadcasts without waiting
 * for each commit. That is what makes depth affordable: blocks are cut by
 * MaxMessageCount at a high submit rate, rather than one per BatchTimeout.
 *
 * Usage:
 *   node load-generator.js --plan plan.json [--concurrency 24] [--dry-run]
 *
 * The plan names channels, members and chaincodes; see populate-plan.json.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
// eslint-disable-next-line import/no-dynamic-require
const { Client, User } = require(path.join(ROOT, 'node_modules', 'fabric-common'));

const MM_HOME = process.env.MM_HOME || path.join(os.homedir(), 'mm');
const TLS = fs.readFileSync(
  process.env.TLS_CA_CERT || path.join(os.homedir(), 'managedblockchain-tls-chain.pem'), 'utf8');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const PLAN = JSON.parse(fs.readFileSync(arg('plan'), 'utf8'));
const CONCURRENCY = Number(arg('concurrency', '24'));
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = arg('only');

function readEnv(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}
const network = readEnv(path.join(MM_HOME, 'network.env'));

// ── Submitters: one client per member, endorsing on that member's own peer ──

const submitters = new Map();
async function submitter(name) {
  if (submitters.has(name)) return submitters.get(name);
  const m = readEnv(path.join(MM_HOME, 'members', `${name}.env`));
  const msp = path.join(MM_HOME, 'msp', name);
  const cert = fs.readFileSync(path.join(msp, 'signcerts', fs.readdirSync(path.join(msp, 'signcerts'))[0]), 'utf8');
  const key = fs.readFileSync(path.join(msp, 'keystore', fs.readdirSync(path.join(msp, 'keystore'))[0]), 'utf8');
  const client = new Client(`load-${name}`);
  const idx = client.newIdentityContext(User.createUser('admin', '', m.MEMBER_ID, cert, key));
  const endorser = client.newEndorser(`peer-${name}`);
  await endorser.connect(client.newEndpoint({ url: `grpcs://${m.PEER_ENDPOINT}`, pem: TLS, requestTimeout: 60000 }));
  const committer = client.newCommitter(`orderer-${name}`);
  await committer.connect(client.newEndpoint({ url: `grpcs://${network.ORDERER_ENDPOINT}`, pem: TLS, requestTimeout: 60000 }));
  const s = { name, mspId: m.MEMBER_ID, client, idx, endorser, committer, channels: new Map() };
  submitters.set(name, s);
  return s;
}

function channelOf(s, ch) {
  if (!s.channels.has(ch)) {
    const c = s.client.newChannel(ch);
    c.addEndorser(s.endorser);
    c.addCommitter(s.committer);
    s.channels.set(ch, c);
  }
  return s.channels.get(ch);
}

const stats = { submitted: 0, endorseFailed: 0, broadcastFailed: 0, byChannel: {} };
const errors = new Map();

async function submit(name, ch, cc, fcn, args, transient) {
  const s = await submitter(name);
  const channel = channelOf(s, ch);
  const e = channel.newEndorsement(cc);
  e.build(s.idx, { fcn, args: args.map(String), transientMap: transient });
  e.sign(s.idx);
  const res = await e.send({ targets: [s.endorser] });
  const r = res.responses && res.responses[0];
  if (!r || !r.response || r.response.status !== 200) {
    stats.endorseFailed++;
    const msg = (r && r.response && r.response.message) || (res.errors && res.errors[0] && res.errors[0].message) || 'no response';
    const k = `${ch}/${cc}/${fcn} as ${name}: ${msg.slice(0, 160)}`;
    errors.set(k, (errors.get(k) || 0) + 1);
    return;
  }
  const commit = e.newCommit();
  commit.build(s.idx);
  commit.sign(s.idx);
  const out = await commit.send({ targets: [s.committer], requestTimeout: 60000 });
  if (out.status !== 'SUCCESS') { stats.broadcastFailed++; return; }
  stats.submitted++;
  stats.byChannel[ch] = (stats.byChannel[ch] || 0) + 1;
}

// ── A bounded pool, so every phase runs at CONCURRENCY in flight ──

async function pool(tasks) {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      try { await t(); } catch (err) {
        stats.broadcastFailed++;
        const k = `exception: ${String(err.message || err).slice(0, 160)}`;
        errors.set(k, (errors.get(k) || 0) + 1);
      }
    }
  });
  await Promise.all(workers);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rot = (list, i) => list[i % list.length];

// Bytes that are not valid UTF-8, plus NUL and every other control byte.
function binary(i) {
  const b = crypto.randomBytes(64 + (i % 64));
  b[0] = 0xff; b[1] = 0xfe; b[2] = 0x00; b[3] = 0xc3; b[4] = 0x28;
  return b;
}

// ── Workloads ──

function ledgerTasks(ch, members, spec, round) {
  const cc = 'consortium_ledger';
  const t = [];
  const keys = spec.keys;
  const per = spec.keysPerTx;
  for (let start = 0, i = 0; start < keys; start += per, i++) {
    const n = Math.min(per, keys - start);
    t.push(() => submit(rot(members, i + round), ch, cc, 'PutMany', ['acct', start, n, spec.valueSize, round]));
  }
  // A rolling delete window: these keys are deleted this round and rewritten
  // the next, so their history carries tombstones in the middle.
  if (round % 4 === 3) {
    const from = ((round * 97) % Math.max(1, keys - 50));
    t.push(() => submit(rot(members, round), ch, cc, 'DeleteMany', ['acct', from, 50]));
  }
  // Deep keys: a few keys rewritten many times a round, so the replay's depth
  // bound (deepest key's versions × commit latency) can be made to dominate
  // its volume bound. Blind writes, so same-block versions do not conflict.
  for (let d = 0; d < (spec.deepKeys || 0); d++) {
    for (let w = 0; w < (spec.deepWritesPerRound || 0); w++) {
      t.push(() => submit(rot(members, d + w + round), ch, cc, 'Put',
        [`deep-${String(d).padStart(2, '0')}`, JSON.stringify({ round, w })]));
    }
  }
  // Private churn.
  const collections = [
    { name: 'allOrgs', writers: members },
    { name: 'pairAB', writers: members.slice(0, 2) },
    { name: 'onlyA', writers: members.slice(0, 1) },
  ];
  for (const col of collections) {
    for (let start = 0, i = 0; start < spec.privateKeys; start += 25, i++) {
      t.push(() => submit(rot(col.writers, i + round), ch, cc, 'PutPrivateMany',
        [col.name, `${col.name}-k`, start, Math.min(25, spec.privateKeys - start), 64, round]));
    }
  }
  for (const m of members) {
    t.push(async () => {
      const s = await submitter(m);
      const col = `_implicit_org_${s.mspId}`;
      for (let start = 0; start < spec.implicitKeys; start += 25) {
        await submit(m, ch, cc, 'PutPrivateMany', [col, 'own', start, Math.min(25, spec.implicitKeys - start), 48, round]);
      }
    });
  }
  return t;
}

function ledgerSpecials(ch, members) {
  const cc = 'consortium_ledger';
  const t = [];
  for (let i = 0; i < 40; i++) {
    t.push(() => submit(rot(members, i), ch, cc, 'PutBinary', [`bin-${String(i).padStart(3, '0')}`], { bin: binary(i) }));
    t.push(() => submit(rot(members, i), ch, cc, 'PutPrivate', ['allOrgs', `bin-${i}`], { val: binary(i + 1000) }));
  }
  for (let i = 0; i < 150; i++) {
    t.push(() => submit(rot(members, i), ch, cc, 'PutComposite',
      ['owner~asset', rot(['alice', 'bob', 'carol', 'dave'], i), `asset-${i}`, JSON.stringify({ i, ch })]));
  }
  // Large values: 150-300 KB, well under AMB's 1 MB default payload limit.
  for (let i = 0; i < 12; i++) {
    t.push(() => submit(rot(members, i), ch, cc, 'PutMany', ['large', i, 1, 150000 + i * 12000, 0]));
  }
  // Hot counters written concurrently: most of these become MVCC_READ_CONFLICT.
  for (let i = 0; i < 120; i++) {
    t.push(() => submit(rot(members, i), ch, cc, 'Incr', [`counter-${i % 4}`]));
  }
  return t;
}

function ephemeral(ch, members, tag) {
  const t = [];
  for (let start = 0, i = 0; start < 200; start += 25, i++) {
    t.push(() => submit(rot(members, i), ch, 'consortium_ledger', 'PutPrivateMany', ['ephemeral', `eph-${tag}`, start, 25, 32, 0]));
  }
  return t;
}

function assetTasks(ch, owner, round, count) {
  const t = [];
  for (let i = 0; i < count; i++) {
    const id = `asset${String(i).padStart(4, '0')}`;
    if (round === 0) {
      t.push(() => submit(owner, ch, 'sample_assets', 'CreateAsset', [id, rot(['alice', 'bob', 'carol'], i), 100 + i, rot(['red', 'blue', 'green'], i), 5 + (i % 10)]));
    } else if (round % 3 === 0) {
      t.push(() => submit(owner, ch, 'sample_assets', 'TransferAsset', [id, rot(['erin', 'frank', 'grace'], i + round)]));
    } else {
      t.push(() => submit(owner, ch, 'sample_assets', 'UpdateAsset', [id, rot(['alice', 'bob', 'carol'], i + round), 100 + i + round * 7, rot(['red', 'blue', 'green'], i + round), 5 + ((i + round) % 10)]));
    }
    if (i % 4 === 0) {
      const appraisal = JSON.stringify({ assetId: id, appraisedValue: 1000 + i * round, appraiser: owner, notes: `r${round}`, timestamp: new Date(0).toISOString() });
      t.push(() => submit(owner, ch, 'sample_assets', 'CreateAppraisal', [], { appraisal: Buffer.from(appraisal) }));
    }
  }
  return t;
}

function tradeTasks(ch, members, round, count) {
  const t = [];
  for (let i = 0; i < count; i++) {
    const id = `T${String(i).padStart(5, '0')}`;
    if (round === 0) {
      t.push(() => submit(rot(members, i), ch, 'trade_registry', 'RegisterTrade', [id, rot(members, i), rot(members, i + 1), rot(['GOLD', 'OIL', 'WHEAT'], i), 10 + i, 1000 + i]));
    } else if (round === PLAN.tradeRounds - 1 && i % 5 === 0) {
      t.push(() => submit(rot(members, i), ch, 'trade_registry', i % 10 === 0 ? 'CloseTrade' : 'CancelTrade', [id]));
    } else if (round < PLAN.tradeRounds - 1) {
      t.push(() => submit(rot(members, i + round), ch, 'trade_registry', 'UpdateTrade', [id, 10 + i + round, 1000 + i + round * 13]));
    }
    if (i % 3 === 0) {
      const info = JSON.stringify({ tradeId: id, account: `acct-${i}-${round}`, routing: '021000021', contact: `ops-${round}@example.com`, recordedAt: new Date(0).toISOString() });
      t.push(() => submit(members[0], ch, 'trade_registry', 'SetCounterpartyInfo', [], { counterparty: Buffer.from(info) }));
    }
  }
  return t;
}

// A steady trickle per channel. AMB cuts a block every BatchTimeout (2s) or
// every 250 transactions, so ledger depth in blocks is set by how long the
// ledger is kept busy, not by how much is written: the trickle keeps every
// channel cutting blocks between rounds, and gives 50 heartbeat keys a version
// in a large share of them.
function startTrickle(channels) {
  let stopped = false;
  const loops = channels.filter((c) => c.chaincodes.includes('consortium_ledger')).map(async (c) => {
    for (let n = 0; !stopped; n++) {
      try {
        await submit(rot(c.members, n), c.name, 'consortium_ledger', 'Put',
          [`heartbeat-${String(n % 50).padStart(2, '0')}`, JSON.stringify({ n, by: rot(c.members, n) })]);
      } catch { /* counted by the pool's peers; a missed beat costs one block */ }
      await sleep(PLAN.trickleMs || 2100);
    }
  });
  return async () => { stopped = true; await Promise.all(loops); };
}

// ── Plan ──

async function main() {
  const started = Date.now();
  const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${msg} ` +
    `(submitted=${stats.submitted} endorseFailed=${stats.endorseFailed} broadcastFailed=${stats.broadcastFailed})`);
  const channels = PLAN.channels.filter((c) => !ONLY || c.name === ONLY);
  // Connected up front and one at a time: two tasks racing into submitter()
  // for the same member would each open a client.
  for (const c of channels) for (const m of c.members) await submitter(m);
  if (DRY_RUN) {
    console.log('connected', [...submitters.keys()]);
    process.exit(0);
  }

  const stopTrickle = startTrickle(channels);

  // Ephemeral writes first, so the deep churn after them pushes them past
  // blockToLive and the coverage report has a purge-window case to report.
  for (const c of channels) await pool(ephemeral(c.name, c.members, 'early'));
  log('ephemeral (early) submitted');

  for (let round = 0; round < PLAN.rounds; round++) {
    const tasks = [];
    for (const c of channels) {
      if (c.chaincodes.includes('consortium_ledger')) tasks.push(...ledgerTasks(c.name, c.members, c.ledger, round));
      if (c.chaincodes.includes('sample_assets') && round < PLAN.assetRounds) tasks.push(...assetTasks(c.name, c.members[0], round, PLAN.assets));
      if (c.chaincodes.includes('trade_registry') && round < PLAN.tradeRounds) tasks.push(...tradeTasks(c.name, c.members, round, PLAN.trades));
    }
    await pool(tasks);
    log(`round ${round + 1}/${PLAN.rounds}`);
    // App chaincodes read before they write; let the round commit first.
    await sleep(PLAN.roundPauseMs || 4000);
  }

  const specials = [];
  for (const c of channels) if (c.chaincodes.includes('consortium_ledger')) specials.push(...ledgerSpecials(c.name, c.members));
  await pool(specials);
  log('specials (binary, composite, large, hot counters)');

  // Permanent deletes of a block of accounts and of private keys.
  const finals = [];
  for (const c of channels) {
    if (!c.chaincodes.includes('consortium_ledger')) continue;
    finals.push(() => submit(c.members[0], c.name, 'consortium_ledger', 'DeleteMany', ['acct', c.ledger.keys - 100, 100]));
    finals.push(() => submit(c.members[0], c.name, 'consortium_ledger', 'DeletePrivateMany', ['onlyA', 'onlyA-k', 0, 25]));
    finals.push(() => submit(c.members[1] || c.members[0], c.name, 'consortium_ledger', 'DeletePrivateMany', ['pairAB', 'pairAB-k', 25, 25]));
  }
  await pool(finals);
  for (const c of channels) await pool(ephemeral(c.name, c.members, 'late'));
  log('final deletes and late ephemeral writes');
  await stopTrickle();
  log('trickle stopped');

  console.log(JSON.stringify({ stats, errors: Object.fromEntries(errors) }, null, 2));
  for (const s of submitters.values()) { s.endorser.disconnect(); s.committer.disconnect(); }
  process.exit(stats.broadcastFailed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
