// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Applying a ConfigUpdate to a config offline, the way the orderer does (configtx update.go, computeUpdateResult).
 * This is what lets the whole chain of updates be computed, and so signed, before anything is sent (design §7;
 * measured equal to the committed chain on 25 updates from 5 real runs).
 *
 *   - a write-set element at the version the config already has is a reference: the config's copy is kept;
 *   - a group whose version rose lists ALL its children, and a child it leaves out is deleted;
 *   - a group at the same version may still list changed children; those it leaves out are kept.
 */
import { ConfigJson } from './configtxlator';
import { canon, clone } from '../util/misc';

const ver = (x: { version?: string | number } | undefined): number => Number(x?.version ?? 0);

function applyGroup(cur: ConfigJson | undefined, ws: ConfigJson): ConfigJson {
  if (!cur) return clone(ws);
  const bumped = ver(ws) !== ver(cur);
  const out: ConfigJson = { version: ws.version, mod_policy: bumped ? ws.mod_policy : cur.mod_policy, groups: {}, values: {}, policies: {} };
  for (const kind of ['values', 'policies'] as const) {
    const names = new Set([...Object.keys(ws[kind] ?? {}), ...(bumped ? [] : Object.keys(cur[kind] ?? {}))]);
    for (const n of names) {
      const w = (ws[kind] ?? {})[n], c = (cur[kind] ?? {})[n];
      out[kind][n] = !w ? c : c && ver(w) === ver(c) ? c : clone(w);
    }
  }
  const gnames = new Set([...Object.keys(ws.groups ?? {}), ...(bumped ? [] : Object.keys(cur.groups ?? {}))]);
  for (const n of gnames) {
    const w = (ws.groups ?? {})[n], c = (cur.groups ?? {})[n];
    out.groups[n] = !w ? c : applyGroup(c, w);
  }
  return out;
}

/** The config that results from applying `update` (decoded ConfigUpdate JSON) to `cur`. */
export function applyUpdate(cur: ConfigJson, update: ConfigJson): ConfigJson {
  return { sequence: String(Number(cur.sequence ?? 0) + 1), channel_group: applyGroup(cur.channel_group, update.write_set) };
}

/** The first path at which two configs differ, or null. */
export function firstDiff(a: ConfigJson, b: ConfigJson, p = ''): string | null {
  if (canon(a) === canon(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) return `${p}/${k}: only in the second`;
      if (!(k in b)) return `${p}/${k}: only in the first`;
      const d = firstDiff(a[k], b[k], `${p}/${k}`);
      if (d) return d;
    }
  }
  const s = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)?.slice(0, 60) ?? 'undefined');
  return `${p}: ${s(a)} != ${s(b)}`;
}

/** MSP IDs of the channel's application orgs. */
export function appOrgs(cfg: ConfigJson): string[] {
  return Object.values(cfg.channel_group.groups.Application.groups as Record<string, ConfigJson>).map((g) => g.values.MSP.value.config.name);
}

/**
 * Does applying this update need an orderer-org admin signature? It does when it changes the Orderer group, or a
 * value or policy at channel level (/Channel/Admins spans both the Application and the Orderer groups).
 */
export function touchesOrdererOrChannel(cur: ConfigJson, update: ConfigJson): boolean {
  const ws = update.write_set ?? {};
  if (ws.groups?.Orderer && ver(ws.groups.Orderer) !== ver(cur.channel_group.groups.Orderer)) return true;
  if (ws.groups?.Orderer && hasChange(cur.channel_group.groups.Orderer, ws.groups.Orderer)) return true;
  if (ver(ws) !== ver(cur.channel_group)) return true;
  for (const kind of ['values', 'policies'] as const) {
    for (const [n, v] of Object.entries((ws[kind] ?? {}) as Record<string, ConfigJson>)) if (ver(v) !== ver(cur.channel_group[kind]?.[n])) return true;
  }
  return false;
}
function hasChange(cur: ConfigJson | undefined, ws: ConfigJson): boolean {
  if (!cur || ver(ws) !== ver(cur)) return true;
  for (const kind of ['values', 'policies'] as const) for (const [n, v] of Object.entries((ws[kind] ?? {}) as Record<string, ConfigJson>)) if (ver(v) !== ver(cur[kind]?.[n])) return true;
  for (const [n, g] of Object.entries((ws.groups ?? {}) as Record<string, ConfigJson>)) if (hasChange(cur.groups?.[n], g)) return true;
  return false;
}
