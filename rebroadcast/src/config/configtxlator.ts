/**
 * The configtxlator boundary. Config JSON (as configtxlator prints it) is the form the transform and the offline
 * chain simulation work in; computing an update delta is left to configtxlator because a bug there would mint wrong
 * config blocks silently (design §4).
 *
 * Files, not pipes: on Linux, Node hands a child a socket for stdio and configtxlator cannot open /dev/stdin on one.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from '../util/misc';
import { Exit, RbError } from '../util/errors';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ConfigJson = any;

export class Configtxlator {
  constructor(
    readonly bin = 'configtxlator',
    expectedSha256?: string,
  ) {
    if (expectedSha256) {
      const resolved = bin.includes('/') ? bin : which(bin);
      const got = sha256(fs.readFileSync(resolved));
      if (got !== expectedSha256) throw new RbError(Exit.Usage, `configtxlator at ${resolved} has SHA-256 ${got}, the descriptor pins ${expectedSha256}`);
    }
  }

  private withTmp<T>(fn: (dir: string) => T): T {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-ctl-'));
    try {
      return fn(d);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && (e as { path?: string }).path === this.bin) throw new RbError(Exit.Usage, `configtxlator not found (${this.bin}): put Fabric 2.5's bin directory on PATH, or set configtxlator.path in the descriptor`);
      throw e;
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }

  decode(type: string, bytes: Uint8Array): ConfigJson {
    return this.withTmp((d) => {
      const i = path.join(d, 'in.pb'), o = path.join(d, 'out.json');
      fs.writeFileSync(i, bytes);
      execFileSync(this.bin, ['proto_decode', '--type', type, '--input', i, '--output', o], { stdio: 'pipe', maxBuffer: 1 << 28 });
      return JSON.parse(fs.readFileSync(o, 'utf8'));
    });
  }

  encode(type: string, json: ConfigJson): Buffer {
    return this.withTmp((d) => {
      const i = path.join(d, 'in.json'), o = path.join(d, 'out.pb');
      fs.writeFileSync(i, JSON.stringify(json));
      execFileSync(this.bin, ['proto_encode', '--type', type, '--input', i, '--output', o], { stdio: 'pipe', maxBuffer: 1 << 28 });
      return fs.readFileSync(o);
    });
  }

  /** The ConfigUpdate bytes taking `original` to `updated`. NOT reproducible byte for byte (Go map order): treat the result as authoritative. */
  computeUpdate(channel: string, original: ConfigJson, updated: ConfigJson): Buffer {
    return this.withTmp((d) => {
      const o = path.join(d, 'o.pb'), n = path.join(d, 'n.pb'), u = path.join(d, 'u.pb');
      fs.writeFileSync(o, this.encode('common.Config', original));
      fs.writeFileSync(n, this.encode('common.Config', updated));
      try {
        execFileSync(this.bin, ['compute_update', '--channel_id', channel, '--original', o, '--updated', n, '--output', u], { stdio: 'pipe' });
      } catch (e) {
        const msg = String((e as { stderr?: Buffer }).stderr ?? e);
        if (/no differences detected/i.test(msg)) return Buffer.alloc(0);
        throw e;
      }
      return fs.readFileSync(u);
    });
  }

  /** The channel config inside a config block. */
  blockConfig(blockBytes: Uint8Array): ConfigJson {
    return this.decode('common.Block', blockBytes).data.data[0].payload.data.config;
  }
}

function which(bin: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    if (fs.existsSync(p)) return p;
  }
  throw new RbError(Exit.Usage, `${bin} not found on PATH`);
}
