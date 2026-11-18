// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fabric-ca-client', () => jest.fn().mockImplementation(() => ({
  enroll: jest.fn(async () => ({ certificate: 'CERT', key: { toBytes: () => 'PRIVATE KEY PEM' } })),
})));

import { WalletManager } from '../src/connection/wallet-manager';

describe('WalletManager CA enrollment', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const profile = {
    organizations: { org1: { mspid: 'Org1MSP' } },
    certificateAuthorities: { ca: { url: 'https://ca.example:30002', tlsCACerts: { pem: 'TLS' } } },
  } as never;

  it('writes every file holding the private key owner-only', async () => {
    const prev = process.umask(0o022);
    try {
      const w = await new WalletManager(dir, 'admin', 'secret').enroll(profile, { memberId: 'm-1' } as never);
      const mode = (p: string): number => fs.statSync(p).mode & 0o777;
      expect(mode(path.join(w.path, 'admin.json'))).toBe(0o600);
      expect(fs.readFileSync(path.join(w.path, 'admin.json'), 'utf-8')).toContain('PRIVATE KEY PEM');
      expect(mode(path.join(w.path, 'msp', 'keystore', 'key.pem'))).toBe(0o600);
      expect(mode(path.join(w.path, 'msp', 'keystore'))).toBe(0o700);
      expect(mode(w.path)).toBe(0o700);
    } finally {
      process.umask(prev);
    }
  });
});
