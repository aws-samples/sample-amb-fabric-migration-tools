/**
 * Resume state binds the last aligned block to both the source archive and the
 * destination. Config blocks differ by construction, so they need two hashes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { decodeBlock } from '../src/fabric/blocks';
import { alignedBlockMatches } from '../src/run/run';
import { chain } from './helpers';

describe('alignedBlockMatches', () => {
  const sourceConfig = decodeBlock(chain('ch', 1)[0]);
  const otherSourceConfig = decodeBlock(chain('other', 1)[0]);
  const destinationConfig = decodeBlock(fs.readFileSync(path.join(__dirname, 'fixtures/genesis-s14k.block')));
  const tx = decodeBlock(chain('ch', 3)[2]);
  const otherTx = decodeBlock(chain('other', 3)[2]);

  it('the fixtures are what the cases need', () => {
    expect(sourceConfig.isConfig && destinationConfig.isConfig && !tx.isConfig).toBe(true);
    expect(destinationConfig.dataHash).not.toBe(sourceConfig.dataHash);
    expect(otherSourceConfig.dataHash).not.toBe(sourceConfig.dataHash);
    expect(otherTx.dataHash).not.toBe(tx.dataHash);
  });

  it('binds a transaction block to the source hash', () => {
    expect(alignedBlockMatches(tx, tx.dataHash, tx.dataHash)).toBe(true);
    expect(alignedBlockMatches(tx, otherTx.dataHash, tx.dataHash)).toBe(false);
    expect(alignedBlockMatches(tx, tx.dataHash, otherTx.dataHash)).toBe(false);
  });

  it('binds a config block to separate source and destination hashes', () => {
    expect(alignedBlockMatches(
      sourceConfig,
      sourceConfig.dataHash,
      destinationConfig.dataHash,
      destinationConfig,
    )).toBe(true);
  });

  it('refuses a different source archive even when the destination config still matches', () => {
    expect(alignedBlockMatches(
      otherSourceConfig,
      sourceConfig.dataHash,
      destinationConfig.dataHash,
      destinationConfig,
    )).toBe(false);
  });

  it('refuses legacy config state without a recorded source hash', () => {
    expect(alignedBlockMatches(
      sourceConfig,
      undefined,
      destinationConfig.dataHash,
      destinationConfig,
    )).toBe(false);
  });

  it('refuses a changed or non-config destination block', () => {
    expect(alignedBlockMatches(
      sourceConfig,
      sourceConfig.dataHash,
      tx.dataHash,
      destinationConfig,
    )).toBe(false);
    expect(alignedBlockMatches(
      sourceConfig,
      sourceConfig.dataHash,
      tx.dataHash,
      tx,
    )).toBe(false);
  });
});
