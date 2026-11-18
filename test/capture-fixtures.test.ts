// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `capture-fixtures` against a peer that does not speak the Gateway service.
 *
 * The command exists to produce real 1.2/1.4 block bytes, and those are exactly
 * the peers `auto` mode cannot reach without a version probe: `createGateway`
 * returns gateway mode optimistically because the gRPC connection succeeds, and
 * the UNIMPLEMENTED answer only arrives on the first evaluate. These tests pin
 * that the probe happens *before* the first capture call, that capture reads
 * through whatever gateway the probe settled on, and that the fixture records
 * which version it came from.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FixtureManifest } from './helpers/fixture-loader';

const events: string[] = [];

/** A `qscc` that serves one JSON block, recording every call it receives. */
function makeGateway(label: string): any {
  const chainInfo = Buffer.from(JSON.stringify({ height: 1 }), 'utf-8');
  const block = Buffer.from(JSON.stringify({ header: { number: '0' } }), 'utf-8');

  return {
    getNetwork: () => ({
      getContract: (name: string) => ({
        evaluateTransaction: async (fcn: string) => {
          events.push(`${label}:${name}.${fcn}`);
          if (name !== 'qscc') throw new Error(`no ${name} on this peer`);
          return fcn === 'GetChainInfo' ? chainInfo : block;
        },
      }),
    }),
  };
}

const gatewayModeResult = {
  gateway: makeGateway('gateway'),
  disconnect: () => events.push('gateway:disconnect'),
  mode: 'gateway' as const,
};

const legacyModeResult = {
  gateway: makeGateway('legacy'),
  disconnect: () => events.push('legacy:disconnect'),
  mode: 'legacy' as const,
};

const v1VersionInfo = {
  applicationCapability: 'V1_4_2',
  channelCapability: 'V1_4_3',
  ordererCapability: 'V1_4_2',
  raw: { application: ['V1_4_2'], channel: ['V1_4_3'], orderer: ['V1_4_2'] },
  applicationMspIds: [],
  majorVersion: '1.x',
  gatewayServiceExpected: false,
  lifecycleAvailable: false,
};

const mockCreateGateway = jest.fn();
const mockDetectAndValidateVersion = jest.fn();

jest.mock('../src/connection/gateway-factory', () => ({
  createGateway: (...args: any[]) => mockCreateGateway(...args),
  detectAndValidateVersion: (...args: any[]) => mockDetectAndValidateVersion(...args),
}));

jest.mock('../src/connection/amb-endpoint-resolver', () => ({
  AmbEndpointResolver: class {
    async resolve() {
      return { stateDb: 'CouchDB' };
    }
  },
}));

jest.mock('../src/connection/connection-profile-builder', () => ({
  ConnectionProfileBuilder: class {
    build() {
      return { organizations: {}, certificateAuthorities: {} };
    }
  },
}));

jest.mock('../src/connection/wallet-manager', () => ({
  WalletManager: class {
    async enroll() {
      return { identity: { mspId: 'Org1MSP' }, path: '/wallet' };
    }
  },
}));

describe('capture-fixtures against a peer with no Gateway service', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-fx-'));
    events.length = 0;
    mockCreateGateway.mockReset();
    mockDetectAndValidateVersion.mockReset();

    // The peer answers the gateway SDK with UNIMPLEMENTED, so the probe
    // reconnects: it disconnects the optimistic handle and returns a legacy one.
    mockCreateGateway.mockImplementation(async () => {
      events.push('createGateway');
      return gatewayModeResult;
    });
    mockDetectAndValidateVersion.mockImplementation(async () => {
      events.push('detectAndValidateVersion');
      gatewayModeResult.disconnect();
      return { result: legacyModeResult, versionInfo: v1VersionInfo };
    });
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  async function runCapture(extraArgs: string[] = []): Promise<void> {
    const { captureFixturesCommand } = await import('../src/cli/commands/capture-fixtures');
    await captureFixturesCommand.parseAsync(
      [
        'node',
        'capture-fixtures',
        '--network-id', 'n-1',
        '--member-id', 'm-1',
        '--node-id', 'nd-1',
        '--channel', 'tradechannel',
        '--end-block', '0',
        '--output-dir', outputDir,
        ...extraArgs,
      ],
    );
  }

  function readManifest(): FixtureManifest {
    return JSON.parse(
      fs.readFileSync(path.join(outputDir, 'tradechannel', 'fixture-manifest.json'), 'utf-8'),
    );
  }

  it('probes the version before issuing any capture request', async () => {
    await runCapture();

    // Without the probe the first qscc call is what discovers the peer cannot
    // answer it, and the command dies instead of falling back.
    expect(events.indexOf('detectAndValidateVersion')).toBeGreaterThan(-1);
    expect(events.indexOf('detectAndValidateVersion')).toBeLessThan(
      events.findIndex((e) => e.includes('qscc.')),
    );
  });

  it('probes the channel it was asked to capture', async () => {
    await runCapture();

    expect(mockDetectAndValidateVersion).toHaveBeenCalledWith(
      gatewayModeResult,
      'tradechannel',
      expect.objectContaining({ mode: 'auto' }),
    );
  });

  it('captures through the gateway the probe settled on, not the one it replaced', async () => {
    await runCapture();

    // The probe disconnected the gateway-mode handle. Reading through it would
    // be reading through a closed connection.
    expect(events.filter((e) => e.startsWith('gateway:qscc'))).toEqual([]);
    expect(events).toContain('legacy:qscc.GetChainInfo');
    expect(events).toContain('legacy:qscc.GetBlockByNumber');
  });

  it('disconnects the gateway it actually used', async () => {
    await runCapture();

    // Both get disconnected — the replaced one by the probe, the live one here.
    // The one that must not be missed is the last event.
    expect(events[events.length - 1]).toBe('legacy:disconnect');
  });

  it('records the Fabric version and SDK mode in the fixture manifest', async () => {
    await runCapture();

    const manifest = readManifest();
    expect(manifest.fabricVersion).toBe('1.x');
    expect(manifest.applicationCapability).toBe('V1_4_2');
    expect(manifest.sdkMode).toBe('legacy');
  });

  it('passes an explicit --fabric-mode through to both the connect and the probe', async () => {
    await runCapture(['--fabric-mode', 'legacy']);

    expect(mockCreateGateway).toHaveBeenCalledWith(expect.objectContaining({ mode: 'legacy' }));
    expect(mockDetectAndValidateVersion).toHaveBeenCalledWith(
      expect.anything(),
      'tradechannel',
      expect.objectContaining({ mode: 'legacy' }),
    );
  });

  it('leaves no fixture manifest behind when a capture dies part-way', async () => {
    const dying = makeGateway('dying');
    const goodGetNetwork = dying.getNetwork;
    dying.getNetwork = () => ({
      getContract: (name: string) => ({
        evaluateTransaction: async (fcn: string, ...rest: string[]) => {
          if (fcn === 'GetBlockByNumber') throw new Error('peer restarted mid-capture');
          return goodGetNetwork().getContract(name).evaluateTransaction(fcn, ...rest);
        },
      }),
    });
    mockDetectAndValidateVersion.mockImplementation(async () => ({
      result: { gateway: dying, disconnect: () => events.push('dying:disconnect'), mode: 'legacy' },
      versionInfo: v1VersionInfo,
    }));

    await expect(runCapture()).rejects.toThrow('peer restarted mid-capture');

    // The manifest is written last on purpose: it is what `findFixtureChannels()`
    // keys on, so writing it earlier would let a truncated block range present
    // itself to the suite as a complete fixture set.
    expect(fs.existsSync(path.join(outputDir, 'tradechannel', 'fixture-manifest.json'))).toBe(
      false,
    );
    expect(events).toContain('dying:disconnect');
  });

  it('leaves no fixture manifest behind when the probe fails', async () => {
    mockDetectAndValidateVersion.mockImplementation(async () => {
      throw new Error('14 UNAVAILABLE: no route to peer');
    });

    await expect(runCapture()).rejects.toThrow('14 UNAVAILABLE');

    // A manifest is what `findFixtureChannels()` keys on, so a half-captured
    // directory must not advertise itself as a usable fixture set.
    expect(fs.existsSync(path.join(outputDir, 'tradechannel', 'fixture-manifest.json'))).toBe(
      false,
    );
  });
});
