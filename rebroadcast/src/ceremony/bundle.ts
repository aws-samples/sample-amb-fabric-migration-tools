// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The config-signing ceremony (design §7), for consortiums where each member holds its own admin key.
 *
 *   export  computes the whole chain of config updates offline (spike S6) and writes a bundle: the update bytes —
 *           authoritative, never recomputed, because compute_update is not reproducible byte for byte — their hashes,
 *           who must sign each, and the config before and after, so a signer can check what they sign.
 *   sign    one member, its own key, nothing else: re-derives what each update changes from the bundle's own bytes
 *           (decode the update, apply it to the config before it, compare with the config after) and signs only then.
 *   import  copies signature files into the bundle, refusing any that does not verify.
 *   verify  per update: which signatures are present, valid and from an MSP and certificate the config accepts.
 *   run --bundle  submits the bundle's updates with its signatures, unchanged.
 *
 * Bundle layout:
 *   bundle.json                      steps, hashes, signers, summaries
 *   updates/<n>.pb                   ConfigUpdate bytes for source config block n
 *   configs/start.json, <n>.json     the config before the first step, and after each step
 *   signatures/<n>.<msp>.json        one per signer per step
 */
import * as fs from 'fs';
import * as path from 'path';
import { common } from '@hyperledger/fabric-protos';
import { Archive } from '../archive/reader';
import { ConfigJson, Configtxlator } from '../config/configtxlator';
import { applyUpdate, firstDiff } from '../config/chain';
import { configStep } from '../config/step';
import { Identity, chainsTo, checkConfigSignature, configSignature } from '../config/signer';
import { Destination } from '../destination';
import { chainStart } from '../plan/start';
import { Exit, RbError } from '../util/errors';
import { canon, sha256 } from '../util/misc';

export interface BundleStep {
  sourceBlock: number;
  update: string;
  updateSha256: string;
  signers: string[];
  changed: string[];
  changes: string[];
  before: string;
  after: string;
}
export interface Bundle {
  schema: 1;
  kind: 'fabric-rebroadcast-config-bundle';
  channel: string;
  profile: string;
  archive: { height: number; digestFileSha256?: string };
  startsAt: number;
  startConfigSha256: string;
  steps: BundleStep[];
  createdAt: string;
}

const pad = (n: number): string => String(n).padStart(8, '0');
const configHash = (c: ConfigJson): string => sha256(canon(c));

/** What a config transition changes, in words: orgs joining and leaving, then every changed value or policy path. */
export function describeChange(before: ConfigJson, after: ConfigJson, max = 25): string[] {
  const out: string[] = [];
  const walk = (a: ConfigJson | undefined, b: ConfigJson | undefined, at: string): void => {
    if (!a && b) { out.push(`+ ${at} (added)`); return; }
    if (a && !b) { out.push(`- ${at} (removed)`); return; }
    for (const kind of ['values', 'policies'] as const) {
      for (const k of new Set([...Object.keys(a[kind] ?? {}), ...Object.keys(b[kind] ?? {})])) {
        const x = a[kind]?.[k], y = b[kind]?.[k];
        if (!x) out.push(`+ ${at}/${kind}/${k}`);
        else if (!y) out.push(`- ${at}/${kind}/${k}`);
        else if (canon(x.value ?? x.policy) !== canon(y.value ?? y.policy) || x.mod_policy !== y.mod_policy) out.push(`~ ${at}/${kind}/${k}`);
      }
    }
    for (const k of new Set([...Object.keys(a.groups ?? {}), ...Object.keys(b.groups ?? {})])) walk(a.groups?.[k], b.groups?.[k], `${at}/${k}`);
  };
  walk(before.channel_group, after.channel_group, 'Channel');
  return out.length > max ? [...out.slice(0, max), `… and ${out.length - max} more`] : out;
}

// ── export ──
export async function exportBundle(archive: Archive, dst: Destination, out: string, opts: { offline?: boolean; log: (s: string) => void }): Promise<Bundle> {
  const { ld, channel, ctl } = dst;
  if (fs.existsSync(path.join(out, 'bundle.json'))) throw new RbError(Exit.Usage, `${out} already holds a bundle; export into an empty directory`);
  const { start, startsAt } = await chainStart(archive, dst, !!opts.offline);
  for (const d of ['updates', 'configs', 'signatures']) fs.mkdirSync(path.join(out, d), { recursive: true });
  fs.writeFileSync(path.join(out, 'configs', 'start.json'), JSON.stringify(start));
  const steps: BundleStep[] = [];
  let cur = start, before = 'configs/start.json';
  for (let n = startsAt; n < archive.height; n++) {
    if (!archive.block(n).isConfig) continue;
    const s = configStep(ctl, ld, channel, cur, archive.raw(n), n);
    if (s.empty) throw new RbError(Exit.Unaligned, `source config block ${n} changes nothing the destination keeps: no block would be made for it`);
    const upd = `updates/${pad(n)}.pb`, after = `configs/${pad(n)}.json`;
    fs.writeFileSync(path.join(out, upd), s.updateBytes);
    fs.writeFileSync(path.join(out, after), JSON.stringify(s.next));
    steps.push({ sourceBlock: n, update: upd, updateSha256: sha256(s.updateBytes), signers: s.signers, changed: s.changed, changes: describeChange(cur, s.next), before, after });
    cur = s.next; before = after;
  }
  const b: Bundle = {
    schema: 1, kind: 'fabric-rebroadcast-config-bundle', channel, profile: ld.d.profile,
    archive: { height: archive.height, digestFileSha256: archive.manifest?.digestFileSha256 },
    startsAt, startConfigSha256: configHash(start), steps, createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out, 'bundle.json'), JSON.stringify(b, null, 2));
  return b;
}

// ── reading ──
export function readBundle(dir: string): Bundle {
  const f = path.join(dir, 'bundle.json');
  if (!fs.existsSync(f)) throw new RbError(Exit.Usage, `${dir} holds no bundle.json`);
  const b = JSON.parse(fs.readFileSync(f, 'utf8')) as Bundle;
  if (b.kind !== 'fabric-rebroadcast-config-bundle' || b.schema !== 1) throw new RbError(Exit.Usage, `${f} is not a config bundle (schema 1)`);
  for (const s of b.steps) {
    if (sha256(fs.readFileSync(path.join(dir, s.update))) !== s.updateSha256) throw new RbError(Exit.Mismatch, `${s.update} does not match the hash recorded in bundle.json`);
  }
  return b;
}
const json = (dir: string, rel: string): ConfigJson => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
export const stepBefore = (dir: string, s: BundleStep): ConfigJson => json(dir, s.before);
export const stepAfter = (dir: string, s: BundleStep): ConfigJson => json(dir, s.after);
export const stepUpdate = (dir: string, s: BundleStep): Buffer => fs.readFileSync(path.join(dir, s.update));

/**
 * The bundle's own consistency, checked with configtxlator by whoever is about to rely on it: each update applied to
 * the config before it gives the config after it, each step starts where the previous ended, and the summary is
 * what the bytes do. Returns the summary recomputed from the bytes.
 */
export function checkBundle(dir: string, b: Bundle, ctl: Configtxlator): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let prev: string | undefined;
  if (configHash(json(dir, 'configs/start.json')) !== b.startConfigSha256) throw new RbError(Exit.Mismatch, 'configs/start.json does not match the start config hash in bundle.json');
  for (const s of b.steps) {
    if (prev && s.before !== prev) throw new RbError(Exit.Mismatch, `step ${s.sourceBlock} does not start from the previous step's result`);
    const before = stepBefore(dir, s), after = stepAfter(dir, s);
    const applied = applyUpdate(before, ctl.decode('common.ConfigUpdate', stepUpdate(dir, s)));
    const d = firstDiff(applied, after);
    if (d) throw new RbError(Exit.Mismatch, `update ${s.sourceBlock} does not produce the recorded result: ${d}`);
    out.set(s.sourceBlock, describeChange(before, after));
    prev = s.after;
  }
  return out;
}

// ── signatures ──
interface SigFile { schema: 1; channel: string; sourceBlock: number; mspId: string; updateSha256: string; signatureHeader: string; signature: string }
const sigName = (n: number, mspId: string): string => `${pad(n)}.${mspId}.json`;

/** The MSP config of `mspId` in a channel config: an application org or an orderer org. */
function mspOf(cfg: ConfigJson, mspId: string): ConfigJson | undefined {
  for (const grp of ['Application', 'Orderer']) {
    for (const g of Object.values((cfg.channel_group.groups[grp]?.groups ?? {}) as Record<string, ConfigJson>)) {
      if (g.values?.MSP?.value?.config?.name === mspId) return g.values.MSP.value.config;
    }
  }
  return undefined;
}

export interface SigCheck { ok: boolean; why: string; mspId: string }
/** A signature file holds for a step when it signs exactly these bytes, as an MSP the step needs, with a certificate that MSP accepts. */
export function checkSigFile(dir: string, b: Bundle, s: BundleStep, f: SigFile): SigCheck {
  const fail = (why: string): SigCheck => ({ ok: false, why, mspId: f.mspId });
  if (f.channel !== b.channel || f.sourceBlock !== s.sourceBlock) return fail('signs a different channel or step');
  if (f.updateSha256 !== s.updateSha256) return fail('signs different update bytes');
  if (!s.signers.includes(f.mspId)) return fail(`${f.mspId} is not a signer of this step`);
  const sig = new common.ConfigSignature();
  sig.setSignatureHeader(Buffer.from(f.signatureHeader, 'base64'));
  sig.setSignature(Buffer.from(f.signature, 'base64'));
  const c = checkConfigSignature(sig, stepUpdate(dir, s));
  if (c.mspId !== f.mspId) return fail(`the signature header names ${c.mspId}, the file ${f.mspId}`);
  if (!c.ok) return fail(c.why);
  const m = mspOf(stepBefore(dir, s), f.mspId);
  if (!m) return fail(`${f.mspId} is not an org of the config this update applies to`);
  if (!chainsTo(c.certPem, [...(m.root_certs ?? []), ...(m.intermediate_certs ?? [])])) return fail(`the signing certificate does not chain to ${f.mspId}'s roots in that config`);
  return { ok: true, why: '', mspId: f.mspId };
}

export function sign(dir: string, b: Bundle, id: Identity, write: boolean): { sourceBlock: number; file: string }[] {
  const done: { sourceBlock: number; file: string }[] = [];
  for (const s of b.steps.filter((x) => x.signers.includes(id.mspId))) {
    const sig = configSignature(id, stepUpdate(dir, s));
    const f: SigFile = {
      schema: 1, channel: b.channel, sourceBlock: s.sourceBlock, mspId: id.mspId, updateSha256: s.updateSha256,
      signatureHeader: Buffer.from(sig.getSignatureHeader_asU8()).toString('base64'), signature: Buffer.from(sig.getSignature_asU8()).toString('base64'),
    };
    const chk = checkSigFile(dir, b, s, f);
    if (!chk.ok) throw new RbError(Exit.SignaturesMissing, `step ${s.sourceBlock}: the signature this key makes would not be accepted (${chk.why})`);
    const name = path.join('signatures', sigName(s.sourceBlock, id.mspId));
    if (write) fs.writeFileSync(path.join(dir, name), JSON.stringify(f, null, 2));
    done.push({ sourceBlock: s.sourceBlock, file: name });
  }
  return done;
}

/** Copy signature files (from files or directories) into the bundle; each must verify against its step. */
export function importSignatures(dir: string, b: Bundle, sources: string[]): { imported: string[]; refused: { file: string; why: string }[] } {
  const files = sources.flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((x) => x.endsWith('.json')).map((x) => path.join(p, x)) : [p]));
  const imported: string[] = [], refused: { file: string; why: string }[] = [];
  for (const file of files) {
    let f: SigFile;
    try { f = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { refused.push({ file, why: 'not JSON' }); continue; }
    const s = b.steps.find((x) => x.sourceBlock === f.sourceBlock);
    if (!s) { refused.push({ file, why: `no step for source block ${f.sourceBlock}` }); continue; }
    const c = checkSigFile(dir, b, s, f);
    if (!c.ok) { refused.push({ file, why: c.why }); continue; }
    const dest = path.join(dir, 'signatures', sigName(f.sourceBlock, f.mspId));
    if (path.resolve(file) !== path.resolve(dest)) fs.writeFileSync(dest, JSON.stringify(f, null, 2));
    imported.push(path.basename(dest));
  }
  return { imported, refused };
}

export interface StepStatus { sourceBlock: number; needs: string[]; valid: string[]; missing: string[]; invalid: { mspId: string; why: string }[] }
export function status(dir: string, b: Bundle): StepStatus[] {
  return b.steps.map((s) => {
    const st: StepStatus = { sourceBlock: s.sourceBlock, needs: s.signers, valid: [], missing: [], invalid: [] };
    for (const m of s.signers) {
      const f = path.join(dir, 'signatures', sigName(s.sourceBlock, m));
      if (!fs.existsSync(f)) { st.missing.push(m); continue; }
      const c = checkSigFile(dir, b, s, JSON.parse(fs.readFileSync(f, 'utf8')));
      if (c.ok) st.valid.push(m); else st.invalid.push({ mspId: m, why: c.why });
    }
    return st;
  });
}

/** The ConfigSignatures for a step, in signer order; throws exit 10 naming everything missing or invalid. */
export function stepSignatures(dir: string, b: Bundle, s: BundleStep): common.ConfigSignature[] {
  const st = status(dir, { ...b, steps: [s] })[0];
  if (st.missing.length || st.invalid.length) {
    throw new RbError(Exit.SignaturesMissing, `config block ${s.sourceBlock} lacks signatures: ${[...st.missing.map((m) => `${m} (missing)`), ...st.invalid.map((x) => `${x.mspId} (${x.why})`)].join(', ')}`);
  }
  return s.signers.map((m) => {
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'signatures', sigName(s.sourceBlock, m)), 'utf8')) as SigFile;
    const sig = new common.ConfigSignature();
    sig.setSignatureHeader(Buffer.from(f.signatureHeader, 'base64'));
    sig.setSignature(Buffer.from(f.signature, 'base64'));
    return sig;
  });
}
