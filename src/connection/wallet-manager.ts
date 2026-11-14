import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConnectionProfile, DiscoverOptions } from '../types';
import { ConnectionError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import { withRetry } from '../utils/retry';

const logger = createLogger('wallet-manager');

export interface WalletIdentity {
  credentials: {
    certificate: string;
    privateKey: string;
  };
  mspId: string;
  type: string;
}

export interface Wallet {
  identity: WalletIdentity;
  path: string;
}

export class WalletManager {
  private walletDir: string;
  private enrollmentId: string;
  private enrollmentSecret: string | undefined;

  constructor(walletDir?: string, enrollmentId = 'admin', enrollmentSecret?: string) {
    this.walletDir = walletDir ?? path.join(process.cwd(), 'wallet');
    this.enrollmentId = enrollmentId;
    this.enrollmentSecret = enrollmentSecret ?? process.env.CA_ENROLLMENT_SECRET;
  }

  /**
   * Load identity from an existing MSP directory. This is the preferred path
   * for anyone who already has an enrolled admin (i.e., every real migration).
   *
   * Expected MSP layout:
   *   <mspPath>/signcerts/cert.pem
   *   <mspPath>/keystore/*_sk  (or any single file)
   */
  loadFromMsp(mspPath: string, mspId: string): Wallet {
    const certPath = path.join(mspPath, 'signcerts', 'cert.pem');
    if (!fs.existsSync(certPath)) {
      throw new ConnectionError(
        `Admin certificate not found at ${certPath}. ` +
          'Ensure --msp-path points to an enrolled MSP directory.',
      );
    }

    // Find the private key — typically named *_sk, but accept any single file in keystore/
    const keystoreDir = path.join(mspPath, 'keystore');
    if (!fs.existsSync(keystoreDir)) {
      throw new ConnectionError(`Keystore directory not found at ${keystoreDir}`);
    }
    const keyFiles = fs.readdirSync(keystoreDir).filter((f) => !f.startsWith('.'));
    if (keyFiles.length === 0) {
      throw new ConnectionError(`No key files found in ${keystoreDir}`);
    }
    const keyPath = path.join(keystoreDir, keyFiles[0]);

    const certificate = fs.readFileSync(certPath, 'utf-8');
    const privateKey = fs.readFileSync(keyPath, 'utf-8');

    const identity: WalletIdentity = {
      credentials: { certificate, privateKey },
      mspId,
      type: 'X.509',
    };

    logger.info({ mspPath, mspId, cert: certPath, key: keyPath }, 'Loaded identity from existing MSP');
    return { identity, path: mspPath };
  }

  async enroll(profile: ConnectionProfile, options: DiscoverOptions): Promise<Wallet> {
    // Prefer existing MSP directory if provided
    if (options.mspPath) {
      const orgNames = Object.keys(profile.organizations);
      const mspId = orgNames.length > 0
        ? profile.organizations[orgNames[0]].mspid
        : options.memberId;
      return this.loadFromMsp(options.mspPath, mspId);
    }

    // Also check $MSP_PATH environment variable
    if (process.env.MSP_PATH) {
      const orgNames = Object.keys(profile.organizations);
      const mspId = orgNames.length > 0
        ? profile.organizations[orgNames[0]].mspid
        : options.memberId;
      logger.info({ mspPath: process.env.MSP_PATH }, 'Using MSP from $MSP_PATH environment variable');
      return this.loadFromMsp(process.env.MSP_PATH, mspId);
    }

    const walletPath = path.join(this.walletDir, options.memberId);
    const identityPath = path.join(walletPath, 'admin.json');

    // Return cached identity if it exists
    if (fs.existsSync(identityPath)) {
      logger.info({ walletPath }, 'Using existing wallet identity');
      const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8')) as WalletIdentity;
      return { identity, path: walletPath };
    }

    if (!this.enrollmentSecret) {
      throw new ConnectionError(
        'No --msp-path provided, no $MSP_PATH set, and no cached wallet found. ' +
          'Either provide --msp-path pointing to an enrolled admin MSP directory, ' +
          'or set $CA_ENROLLMENT_SECRET for automatic CA enrollment.',
      );
    }

    logger.info('No --msp-path provided and no cached wallet found; enrolling via CA');

    // Get CA endpoint from profile
    const caNames = Object.keys(profile.certificateAuthorities);
    if (caNames.length === 0) {
      throw new ConnectionError('No certificate authority found in connection profile');
    }
    const caUrl = profile.certificateAuthorities[caNames[0]].url;
    const caEntry = profile.certificateAuthorities[caNames[0]];
    const tlsCertPath = caEntry.tlsCACerts.path;
    const tlsCertPem = caEntry.tlsCACerts.pem;

    // Get MSP ID from profile
    const orgNames = Object.keys(profile.organizations);
    if (orgNames.length === 0) {
      throw new ConnectionError('No organization found in connection profile');
    }
    const mspId = profile.organizations[orgNames[0]].mspid;

    // Enroll using fabric-ca-client SDK
    const identity = await withRetry(
      async () => this.enrollWithCa(
        caUrl, tlsCertPath, tlsCertPem, mspId,
      ),
      'CA enrollment',
    );

    // Persist to wallet directory
    // The identity file holds the private key: owner-only, like the keystore below.
    fs.mkdirSync(walletPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), { mode: 0o600 });
    fs.chmodSync(identityPath, 0o600); // an existing file keeps its mode through writeFileSync

    // AMB-specific: copy signcerts to admincerts
    const mspDir = path.join(walletPath, 'msp');
    const signcertsDir = path.join(mspDir, 'signcerts');
    const admincertsDir = path.join(mspDir, 'admincerts');
    const keystoreDir = path.join(mspDir, 'keystore');
    fs.mkdirSync(signcertsDir, { recursive: true });
    fs.mkdirSync(admincertsDir, { recursive: true });
    fs.mkdirSync(keystoreDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(signcertsDir, 'cert.pem'), identity.credentials.certificate);
    fs.writeFileSync(path.join(admincertsDir, 'cert.pem'), identity.credentials.certificate);
    fs.writeFileSync(path.join(keystoreDir, 'key.pem'), identity.credentials.privateKey, { mode: 0o600 });

    logger.info({ walletPath, mspId }, 'Admin identity enrolled and stored');
    return { identity, path: walletPath };
  }

  private async enrollWithCa(
    caUrl: string,
    tlsCertPath: string | undefined,
    tlsCertPem: string | undefined,
    mspId: string,
  ): Promise<WalletIdentity> {
    // fabric-ca-client is a CommonJS module with no default export to await.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FabricCAServices = require('fabric-ca-client');

    const tlsCert = tlsCertPath
      ? fs.readFileSync(tlsCertPath, 'utf-8')
      : tlsCertPem ?? '';
    const ca = new FabricCAServices(caUrl, {
      trustedRoots: [tlsCert],
      verify: true,
    });

    const enrollment = await ca.enroll({
      enrollmentID: this.enrollmentId,
      enrollmentSecret: this.enrollmentSecret,
    });

    return {
      credentials: {
        certificate: enrollment.certificate,
        privateKey: enrollment.key.toBytes(),
      },
      mspId,
      type: 'X.509',
    };
  }

  getIdentityFingerprint(certificate: string): string {
    const hash = crypto.createHash('sha256').update(certificate).digest('hex');
    return `sha256:${hash}`;
  }
}
