import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createPrivateKey: jest.fn().mockReturnValue({}),
}));
jest.mock('@grpc/grpc-js');
jest.mock('@hyperledger/fabric-gateway');

import * as grpc from '@grpc/grpc-js';
import { connect, signers } from '@hyperledger/fabric-gateway';
import { FabricGateway } from '../src/connection/fabric-gateway';
import { AmbGateway } from '../src/connection/amb-gateway';
import { DEFAULT_GRPC_TIMEOUTS, GRPC_MAX_RECEIVE_BYTES, GrpcTimeouts } from '../src/types';

let tmpDir: string;
let certPath: string;
let keyPath: string;
let profilePath: string;

const FAKE_CERT = 'FAKE-CERT-PEM-CONTENT';
const FAKE_KEY = 'FAKE-KEY-PEM-CONTENT';

function writeProfile(peerUrl: string, tlsCACerts: unknown = { pem: FAKE_CERT }): void {
  const profile: any = {
    peers: {
      'peer0.org1.example.com': {
        url: peerUrl,
        ...(tlsCACerts !== undefined && { tlsCACerts }),
      },
    },
    certificateAuthorities: {},
  };
  fs.writeFileSync(profilePath, JSON.stringify(profile), 'utf-8');
}

/** The profile and wallet `AmbGateway.connect` takes in place of files on disk. */
function ambProfile(): any {
  return {
    peers: {
      'peer0.org1.example.com': {
        url: 'grpcs://peer0.org1.example.com:7051',
        tlsCACerts: { pem: FAKE_CERT },
      },
    },
    certificateAuthorities: {},
  };
}

function ambWallet(): any {
  return {
    identity: {
      mspId: 'Org1MSP',
      credentials: { certificate: FAKE_CERT, privateKey: FAKE_KEY },
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-test-'));
  certPath = path.join(tmpDir, 'cert.pem');
  keyPath = path.join(tmpDir, 'key.pem');
  profilePath = path.join(tmpDir, 'profile.json');

  fs.writeFileSync(certPath, FAKE_CERT, 'utf-8');
  fs.writeFileSync(keyPath, FAKE_KEY, 'utf-8');

  jest.clearAllMocks();

  (grpc.credentials.createSsl as jest.Mock).mockReturnValue({});
  (grpc.credentials.createInsecure as jest.Mock).mockReturnValue({});
  (grpc.Client as unknown as jest.Mock).mockImplementation(() => ({
    close: jest.fn(),
  }));

  const mockSigner = jest.fn();
  (signers.newPrivateKeySigner as jest.Mock).mockReturnValue(mockSigner);

  (connect as jest.Mock).mockReturnValue({
    close: jest.fn(),
    getNetwork: jest.fn(),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('FabricGateway.connect — allowInsecure', () => {
  test('throws ConnectionError on grpc:// without allowInsecure', async () => {
    writeProfile('grpc://peer0.org1.example.com:7051');
    const gw = new FabricGateway();

    await expect(
      gw.connect({
        connectionProfilePath: profilePath,
        mspId: 'Org1MSP',
        certPath,
        keyPath,
      }),
    ).rejects.toThrow(/plaintext gRPC/);
  });

  test('allows grpc:// with allowInsecure: true', async () => {
    writeProfile('grpc://peer0.org1.example.com:7051');
    const gw = new FabricGateway();

    await gw.connect({
      connectionProfilePath: profilePath,
      mspId: 'Org1MSP',
      certPath,
      keyPath,
      allowInsecure: true,
    });

    expect(grpc.credentials.createInsecure).toHaveBeenCalled();
    expect(connect).toHaveBeenCalled();
  });

  test('uses TLS for grpcs:// without allowInsecure', async () => {
    writeProfile('grpcs://peer0.org1.example.com:7051');
    const gw = new FabricGateway();

    await gw.connect({
      connectionProfilePath: profilePath,
      mspId: 'Org1MSP',
      certPath,
      keyPath,
    });

    expect(grpc.credentials.createSsl).toHaveBeenCalledWith(Buffer.from(FAKE_CERT));
    expect(connect).toHaveBeenCalled();
  });

  test('refuses grpcs:// with no tlsCACerts rather than trusting system roots', async () => {
    writeProfile('grpcs://peer0.org1.example.com:7051', null);

    await expect(
      new FabricGateway().connect({ connectionProfilePath: profilePath, mspId: 'Org1MSP', certPath, keyPath }),
    ).rejects.toThrow(/no tlsCACerts/);
    expect(grpc.credentials.createSsl).not.toHaveBeenCalled();
  });

  test('falls back to tlsCACerts.pem when the path does not exist', async () => {
    writeProfile('grpcs://peer0.org1.example.com:7051', { path: path.join(tmpDir, 'missing.pem'), pem: FAKE_CERT });

    await new FabricGateway().connect({ connectionProfilePath: profilePath, mspId: 'Org1MSP', certPath, keyPath });
    expect(grpc.credentials.createSsl).toHaveBeenCalledWith(Buffer.from(FAKE_CERT));
  });

  test('refuses a tlsCACerts.path that does not exist', async () => {
    writeProfile('grpcs://peer0.org1.example.com:7051', { path: path.join(tmpDir, 'missing.pem') });

    await expect(
      new FabricGateway().connect({ connectionProfilePath: profilePath, mspId: 'Org1MSP', certPath, keyPath }),
    ).rejects.toThrow(/does not exist/);
  });
});

// grpc-js caps receives at 4 MiB. Both raw clients this tool builds are on the
// replay/verify side, which reads values and histories back out of a
// destination; the extraction side goes through fabric-common, which sets -1.
describe('gRPC message limits', () => {
  /** Channel options the last-built client was given. */
  function clientOptions(): Record<string, unknown> {
    const calls = (grpc.Client as unknown as jest.Mock).mock.calls;
    return calls[calls.length - 1][2];
  }

  test('FabricGateway raises the receive cap above the grpc-js default', async () => {
    writeProfile('grpcs://peer0.org1.example.com:7051');

    await new FabricGateway().connect({
      connectionProfilePath: profilePath,
      mspId: 'Org1MSP',
      certPath,
      keyPath,
    });

    expect(clientOptions()['grpc.max_receive_message_length']).toBe(GRPC_MAX_RECEIVE_BYTES);
    expect(GRPC_MAX_RECEIVE_BYTES).toBeGreaterThan(4 * 1024 * 1024);
  });

  test('AmbGateway raises it too, from the same constant', async () => {
    // Two clients, one limit: a value readable through one and not the other
    // would depend on which SDK mode the command happened to pick.
    await new AmbGateway().connect(ambProfile(), ambWallet());

    expect(clientOptions()['grpc.max_receive_message_length']).toBe(GRPC_MAX_RECEIVE_BYTES);
  });

  test('leaves the send direction at the SDK default', async () => {
    // grpc-js does not cap sends, and nothing here has asked for one: replay
    // submits values through the same client, and a cap set from this side
    // would refuse a write the destination peer would have accepted.
    writeProfile('grpcs://peer0.org1.example.com:7051');

    await new FabricGateway().connect({
      connectionProfilePath: profilePath,
      mspId: 'Org1MSP',
      certPath,
      keyPath,
    });

    expect(clientOptions()['grpc.max_send_message_length']).toBeUndefined();
  });
});

/** One deadline per option callback the SDK is given, bracketed by the clock. */
interface Deadlines {
  evaluate: number;
  endorse: number;
  submit: number;
  commitStatus: number;
  before: number;
  after: number;
}

/**
 * Reads all four deadlines the way the SDK reads them — by calling the option
 * callback — with a clock reading either side.
 *
 * Each callback reads `Date.now()` when it is *called*, so the deadline it
 * returns is offset from some instant between `before` and `after` and not from
 * any single reading taken beforehand. Bracketing states that; a tolerance
 * around one reading only guesses at how wide the gap can get, and is wrong
 * whenever a stall makes it wider.
 */
function deadlines(): Deadlines {
  const options = (connect as jest.Mock).mock.calls[0][0];
  const before = Date.now();
  const read = {
    evaluate: options.evaluateOptions().deadline,
    endorse: options.endorseOptions().deadline,
    submit: options.submitOptions().deadline,
    commitStatus: options.commitStatusOptions().deadline,
  };

  return { ...read, before, after: Date.now() };
}

/** Asserts `deadline` is `offset` ms past a clock reading inside the bracket. */
function expectOffset(deadline: number, offset: number, bracket: Deadlines): void {
  expect(deadline).toBeGreaterThanOrEqual(bracket.before + offset);
  expect(deadline).toBeLessThanOrEqual(bracket.after + offset);
}

// Both gateways wire the same four deadlines out of the same two settings, and
// `gateway-factory` chooses between them per network — so a deadline that held
// on one and not the other would be a timeout that changed with the SDK mode
// rather than with the config.
describe.each([
  {
    name: 'FabricGateway',
    open: (timeouts?: GrpcTimeouts) => {
      writeProfile('grpcs://peer0.org1.example.com:7051');
      return new FabricGateway().connect({
        connectionProfilePath: profilePath,
        mspId: 'Org1MSP',
        certPath,
        keyPath,
        ...(timeouts && { timeouts }),
      });
    },
  },
  {
    name: 'AmbGateway',
    open: (timeouts?: GrpcTimeouts) =>
      new AmbGateway().connect(ambProfile(), ambWallet(), timeouts),
  },
])('$name.connect — GrpcTimeouts', ({ open }) => {
  test('custom timeouts reach every call the SDK deadlines', async () => {
    // Endorse and submit are the replay write path: a deadline missing there is
    // 30 s of default on a call the operator asked to give 5 s to.
    await open({ requestMs: 5000, commitMs: 10000 });

    const read = deadlines();

    expectOffset(read.evaluate, 5000, read);
    expectOffset(read.endorse, 5000, read);
    expectOffset(read.submit, 5000, read);
    expectOffset(read.commitStatus, 10000, read);
  });

  test('defaults are used when no timeouts are specified', async () => {
    await open();

    const read = deadlines();

    expectOffset(read.evaluate, DEFAULT_GRPC_TIMEOUTS.requestMs, read);
    expectOffset(read.endorse, DEFAULT_GRPC_TIMEOUTS.requestMs, read);
    expectOffset(read.submit, DEFAULT_GRPC_TIMEOUTS.requestMs, read);
    expectOffset(read.commitStatus, DEFAULT_GRPC_TIMEOUTS.commitMs, read);
  });
});

// A destination reached by IP presents a certificate for its own hostname.
describe('FabricGateway TLS hostname', () => {
  function clientOptions(): Record<string, unknown> {
    const calls = (grpc.Client as unknown as jest.Mock).mock.calls;
    return calls[calls.length - 1][2];
  }

  async function connectTo(peer: Record<string, unknown>): Promise<void> {
    fs.writeFileSync(profilePath, JSON.stringify({ peers: { p: peer } }), 'utf-8');
    await new FabricGateway().connect({
      connectionProfilePath: profilePath, mspId: 'Org1MSP', certPath, keyPath,
    });
  }

  test('checks the profile\'s ssl-target-name-override', async () => {
    await connectTo({
      url: 'grpcs://10.0.1.5:7051',
      tlsCACerts: { pem: FAKE_CERT },
      grpcOptions: { 'ssl-target-name-override': 'peer0.org1.example.com' },
    });

    expect(clientOptions()['grpc.ssl_target_name_override']).toBe('peer0.org1.example.com');
  });

  test('checks the dialled host when the profile names no override', async () => {
    await connectTo({ url: 'grpcs://peer0.org1.example.com:7051', tlsCACerts: { pem: FAKE_CERT } });

    expect(clientOptions()['grpc.ssl_target_name_override']).toBe('peer0.org1.example.com');
  });
});
