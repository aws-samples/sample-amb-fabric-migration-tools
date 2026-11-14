/**
 * The destination descriptor (design §6.2): where the destination's orderer and peers are, which identity signs as
 * each source org, and what the first config update may change. Secrets are referenced by path only; paths are
 * relative to the descriptor file. Unknown keys are refused, so a typo cannot silently drop a setting.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Exit, RbError } from './util/errors';
import { durationMs } from './util/misc';
import { Identity, identity } from './config/signer';

export interface Endpoint { address: string; tlsCa: string; clientCert?: string; clientKey?: string; sni?: string }
export interface Signer { msp: string; cert: string; key: string }
export interface OrgEntry { signer: { mode: 'local'; cert: string; key: string } | { mode: 'ceremony'; cert: string; key?: undefined }; rootCa: string; tlsRootCa: string; anchorPeers?: { host: string; port: number }[] }
export interface Descriptor {
  schema: 1;
  profile: 'self-managed' | 'provider';
  /** endpoints: every orderer of the destination's ordering service (any one serves the channel; the tool fails over between them). */
  orderer: { mode: 'timeout' | 'cut-markers'; batchTimeout: string; endpoints: Endpoint[]; reader: Signer };
  peers?: (Endpoint & { reader: Signer })[];
  /** provider: the platform's own org, admin of the channel as the platform created it. */
  platform?: { msp: string; admin: { cert: string; key: string } };
  /** self-managed: the destination's orderer org; its admin signs changes to the Orderer group or channel-level values. */
  ordererOrg?: { msp: string; admin: { cert: string; key: string } };
  /** self-managed: a configtxgen block for the destination (its Orderer group is used); input of `genesis`. */
  genesisTemplate?: string;
  orgs: Record<string, OrgEntry>;
  ordererOverrides?: { BatchTimeout?: string; BatchSize?: { max_message_count?: number; absolute_max_bytes?: number; preferred_max_bytes?: number } };
  configtxlator?: { path: string; sha256?: string };
  /** Directory for state/<channel>.json and report/<channel>.ndjson; default: next to the descriptor. */
  workDir?: string;
}

type Shape = { [k: string]: 'string' | 'number' | 'object' | 'array' | Shape | ['map', Shape] | ['list', Shape] | ['enum', ...string[]] };
const ENDPOINT: Shape = { address: 'string', tlsCa: 'string', clientCert: 'string', clientKey: 'string', sni: 'string' };
const SIGNER: Shape = { msp: 'string', cert: 'string', key: 'string' };
const KEYPAIR: Shape = { cert: 'string', key: 'string' };
const SCHEMA: Shape = {
  schema: 'number',
  profile: ['enum', 'self-managed', 'provider'],
  orderer: { mode: ['enum', 'timeout', 'cut-markers'], batchTimeout: 'string', endpoints: ['list', ENDPOINT], reader: SIGNER },
  peers: ['list', { ...ENDPOINT, reader: SIGNER }],
  platform: { msp: 'string', admin: KEYPAIR },
  ordererOrg: { msp: 'string', admin: KEYPAIR },
  genesisTemplate: 'string',
  orgs: ['map', { signer: { mode: ['enum', 'local', 'ceremony'], cert: 'string', key: 'string' }, rootCa: 'string', tlsRootCa: 'string', anchorPeers: 'array' }],
  ordererOverrides: { BatchTimeout: 'string', BatchSize: { max_message_count: 'number', absolute_max_bytes: 'number', preferred_max_bytes: 'number' } },
  configtxlator: { path: 'string', sha256: 'string' },
  workDir: 'string',
};
const REQUIRED: Record<string, string[]> = {
  '': ['schema', 'profile', 'orderer', 'orgs'],
  orderer: ['mode', 'batchTimeout', 'endpoints', 'reader'],
  'orderer.reader': ['msp', 'cert', 'key'],
  platform: ['msp', 'admin'],
  ordererOrg: ['msp', 'admin'],
};

function check(v: unknown, shape: Shape, at: string, errs: string[]): void {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push(`${at || 'descriptor'}: must be an object`); return; }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(k in shape)) errs.push(`${at ? at + '.' : ''}${k}: unknown key`);
  for (const r of REQUIRED[at] ?? []) if (o[r] === undefined) errs.push(`${at ? at + '.' : ''}${r}: required`);
  for (const [k, t] of Object.entries(shape)) {
    const x = o[k], p = at ? `${at}.${k}` : k;
    if (x === undefined) continue;
    if (t === 'string' || t === 'number') { if (typeof x !== t) errs.push(`${p}: must be a ${t}`); }
    else if (t === 'object') { if (!x || typeof x !== 'object') errs.push(`${p}: must be an object`); }
    else if (t === 'array') { if (!Array.isArray(x)) errs.push(`${p}: must be an array`); }
    else if (Array.isArray(t) && t[0] === 'enum') { if (!t.slice(1).includes(x as string)) errs.push(`${p}: must be one of ${t.slice(1).join(', ')}`); }
    else if (Array.isArray(t) && t[0] === 'map') { if (!x || typeof x !== 'object') errs.push(`${p}: must be an object`); else for (const [mk, mv] of Object.entries(x)) check(mv, t[1] as Shape, `${p}.${mk}`, errs); }
    else if (Array.isArray(t) && t[0] === 'list') { if (!Array.isArray(x)) errs.push(`${p}: must be an array`); else x.forEach((e, i) => check(e, t[1] as Shape, `${p}[${i}]`, errs)); }
    else check(x, t as Shape, p, errs);
  }
}

export interface LoadedDescriptor {
  d: Descriptor;
  file: string;
  dir: string;
  /** Resolve a path written in the descriptor. */
  p: (rel: string) => string;
  workDir: string;
}

export function loadDescriptor(file: string): LoadedDescriptor {
  const abs = path.resolve(file);
  let d: Descriptor;
  try {
    d = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new RbError(Exit.Usage, `cannot read descriptor ${file}: ${(e as Error).message}`);
  }
  const errs: string[] = [];
  check(d, SCHEMA, '', errs);
  for (const [k, o] of Object.entries(d.orgs ?? {})) {
    for (const r of ['signer', 'rootCa', 'tlsRootCa']) if ((o as unknown as Record<string, unknown>)[r] === undefined) errs.push(`orgs.${k}.${r}: required`);
    const sg = (o as OrgEntry).signer;
    if (sg?.mode === 'local' && !sg.key) errs.push(`orgs.${k}.signer.key: required for mode "local"`);
    if (sg?.mode === 'ceremony' && sg.key) errs.push(`orgs.${k}.signer.key: a ceremony signer's key stays with its member; remove it`);
    if (sg && !sg.cert) errs.push(`orgs.${k}.signer.cert: required (the certificate the org signs config updates with)`);
  }
  if (Array.isArray(d.orderer?.endpoints)) {
    if (!d.orderer.endpoints.length) errs.push('orderer.endpoints: needs at least one orderer');
    d.orderer.endpoints.forEach((e, i) => { for (const r of ['address', 'tlsCa'] as const) if (e && e[r] === undefined) errs.push(`orderer.endpoints[${i}].${r}: required`); });
    const dup = d.orderer.endpoints.map((e) => e?.address).filter((a, i, all) => a && all.indexOf(a) !== i);
    if (dup.length) errs.push(`orderer.endpoints: ${dup.join(', ')} listed twice`);
  }
  if (d.schema !== 1) errs.push('schema: must be 1');
  if (d.profile === 'provider' && !d.platform) errs.push('platform: required for profile "provider"');
  if (d.profile === 'self-managed' && d.orderer?.mode === 'cut-markers') { /* fine */ }
  if (d.profile === 'provider' && d.orderer?.mode === 'cut-markers') errs.push('orderer.mode: cut-markers needs the patched orderer, which a provider does not run');
  try { if (d.orderer?.batchTimeout) durationMs(d.orderer.batchTimeout); } catch (e) { errs.push(`orderer.batchTimeout: ${(e as Error).message}`); }
  if (d.ordererOverrides?.BatchTimeout && d.ordererOverrides.BatchTimeout !== d.orderer?.batchTimeout) errs.push('ordererOverrides.BatchTimeout must equal orderer.batchTimeout (the tool paces blocks by it)');
  if (errs.length) throw new RbError(Exit.Usage, `descriptor ${file} is invalid:\n  ${errs.join('\n  ')}`);
  const dir = path.dirname(abs);
  const p = (rel: string): string => path.resolve(dir, rel);
  const missing: string[] = [];
  const need = (rel: string | undefined, what: string): void => { if (rel && !fs.existsSync(p(rel))) missing.push(`${what}: ${rel}`); };
  d.orderer.endpoints.forEach((e, i) => { need(e.tlsCa, `orderer.endpoints[${i}].tlsCa`); need(e.clientCert, `orderer.endpoints[${i}].clientCert`); need(e.clientKey, `orderer.endpoints[${i}].clientKey`); });
  need(d.orderer.reader.cert, 'orderer.reader.cert'); need(d.orderer.reader.key, 'orderer.reader.key');
  for (const [k, o] of Object.entries(d.orgs)) { need(o.signer.cert, `orgs.${k}.signer.cert`); need(o.signer.key ?? undefined, `orgs.${k}.signer.key`); need(o.rootCa, `orgs.${k}.rootCa`); need(o.tlsRootCa, `orgs.${k}.tlsRootCa`); }
  need(d.genesisTemplate, 'genesisTemplate');
  if (missing.length) throw new RbError(Exit.Usage, `descriptor ${file} names files that do not exist:\n  ${missing.join('\n  ')}`);
  return { d, file: abs, dir, p, workDir: d.workDir ? p(d.workDir) : dir };
}

export function loadSigner(ld: LoadedDescriptor, s: { cert: string; key: string }, mspId: string): Identity {
  return identity(mspId, ld.p(s.cert), ld.p(s.key));
}
