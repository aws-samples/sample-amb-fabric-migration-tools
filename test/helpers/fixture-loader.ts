// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';

/**
 * Metadata about a captured block fixture.
 */
export interface BlockFixture {
  blockNumber: number;
  rawFile: string;
  jsonFile: string | null;
  rawSizeBytes: number;
  isProtobuf: boolean;
}

/**
 * Metadata from the fixture capture run.
 */
export interface FixtureManifest {
  capturedAt: string;
  networkId: string;
  memberId: string;
  channel: string;
  region: string;
  /** Which Fabric version produced these bytes — `'1.x'` or `'2.x'`. */
  fabricVersion: string;
  /** The exact application capability behind that label, e.g. `'V1_4_2'`. */
  applicationCapability: string;
  /** Which SDK read them: a 1.x capture must have come through `'legacy'`. */
  sdkMode: 'gateway' | 'legacy';
  ledgerHeight: number;
  startBlock: number;
  endBlock: number;
  totalBlocks: number;
  stateDb: string;
  protobufBlocks: number;
  jsonBlocks: number;
  blocks: BlockFixture[];
}

/**
 * Loads block fixtures captured by `capture-fixtures` and exposes them
 * through the same interface as a Fabric `Contract.evaluateTransaction`.
 *
 * Usage:
 *   const loader = new FixtureLoader('./test/fixtures/tradechannel');
 *   const network = loader.asMockNetwork();
 *   // Pass `network` to BlockWalker, StateReconstructionExtractor, etc.
 */
export class FixtureLoader {
  private manifest: FixtureManifest;
  private fixtureDir: string;
  private blocksDir: string;
  private blockCache = new Map<number, Buffer>();

  constructor(fixtureDir: string) {
    this.fixtureDir = fixtureDir;
    this.blocksDir = path.join(fixtureDir, 'blocks');

    const manifestPath = path.join(fixtureDir, 'fixture-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `Fixture manifest not found at ${manifestPath}. ` +
          'Run `amb-migrate capture-fixtures` against a live peer first.',
      );
    }

    this.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }

  getManifest(): FixtureManifest {
    return this.manifest;
  }

  /**
   * Load a single block's raw bytes (as returned by the peer).
   */
  loadBlockRaw(blockNumber: number): Buffer {
    if (this.blockCache.has(blockNumber)) {
      return this.blockCache.get(blockNumber)!;
    }

    const fixture = this.manifest.blocks.find((b) => b.blockNumber === blockNumber);
    if (!fixture) {
      throw new Error(`Block ${blockNumber} not in fixture set (range: ${this.manifest.startBlock}-${this.manifest.endBlock})`);
    }

    const buf = fs.readFileSync(path.join(this.blocksDir, fixture.rawFile));
    this.blockCache.set(blockNumber, buf);
    return buf;
  }

  /**
   * Load a block's decoded JSON (if available). Returns null for protobuf-only blocks.
   */
  loadBlockJson(blockNumber: number): any | null {
    const fixture = this.manifest.blocks.find((b) => b.blockNumber === blockNumber);
    if (!fixture?.jsonFile) return null;

    return JSON.parse(fs.readFileSync(path.join(this.blocksDir, fixture.jsonFile), 'utf-8'));
  }

  /**
   * Load the raw chain info response.
   */
  loadChainInfo(): Buffer {
    return fs.readFileSync(path.join(this.fixtureDir, 'chain-info.raw'));
  }

  /**
   * Build a mock Fabric `Network` object that serves captured blocks
   * through the same `qscc` interface the extractor uses.
   *
   * This is the key integration point: swap the real gRPC peer for
   * captured fixture data, exercising the real decode + parse paths.
   */
  asMockNetwork(): any {
    const mockContract = {
      evaluateTransaction: async (...args: string[]): Promise<Uint8Array> => {
        const [fcn, _channelId, blockNumStr] = args;

        if (fcn === 'GetBlockByNumber') {
          const blockNum = parseInt(blockNumStr, 10);
          const raw = this.loadBlockRaw(blockNum);
          return new Uint8Array(raw);
        }

        if (fcn === 'GetChainInfo') {
          const raw = this.loadChainInfo();
          return new Uint8Array(raw);
        }

        throw new Error(`Unexpected qscc function in fixture mock: ${fcn}`);
      },
    };

    return {
      getContract: (name: string) => {
        if (name === 'qscc') return mockContract;
        throw new Error(`Fixture mock only supports qscc, got: ${name}`);
      },
    };
  }

  /**
   * Summary of what's in the fixture set.
   */
  summary(): string {
    const m = this.manifest;
    return [
      `Channel: ${m.channel}`,
      `Fabric: ${m.fabricVersion} (${m.applicationCapability}) via ${m.sdkMode} SDK`,
      `Blocks: ${m.startBlock}-${m.endBlock} (${m.totalBlocks} total)`,
      `Ledger height: ${m.ledgerHeight}`,
      `JSON-decodable: ${m.jsonBlocks}, Protobuf-only: ${m.protobufBlocks}`,
      `State DB: ${m.stateDb}`,
      `Captured: ${m.capturedAt}`,
    ].join('\n');
  }
}
