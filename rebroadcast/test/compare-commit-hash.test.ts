/**
 * `compare` via a peer: the commit hash. A peer adds one from block 1, or after a block that has one, so a source
 * ledger that started on a Fabric version without commit hashes has none on any block. That source block cannot be
 * compared, which is not a difference; a destination block without one, where the source has one, is.
 */
import { common } from '@hyperledger/fabric-protos';
import { Archive } from '../src/archive/reader';
import { compare } from '../src/compare/compare';
import { Destination } from '../src/destination';
import { decodeBlock } from '../src/fabric/blocks';
import { chain } from './helpers';

/** The block with commit hash `hash` in metadata slot 4, or none when `hash` is empty. */
function withCommitHash(bytes: Buffer, hash: string): Buffer {
  const b = common.Block.deserializeBinary(bytes);
  const md = b.getMetadata()!.getMetadataList_asU8().map((x) => Buffer.from(x));
  const m = new common.Metadata();
  m.setValue(Buffer.from(hash, 'hex'));
  md[4] = hash ? Buffer.from(m.serializeBinary()) : Buffer.alloc(0);
  b.getMetadata()!.setMetadataList(md);
  return Buffer.from(b.serializeBinary());
}

describe('compare via a peer: commit hash', () => {
  const blocks = chain('ch', 3);
  const hashes = ['', 'aa11', 'bb22'];

  const run = (source: string[], destination: string[]) => {
    const src = blocks.map((b, n) => withCommitHash(b, source[n]));
    const dst = blocks.map((b, n) => withCommitHash(b, destination[n]));
    const archive = { height: 3, block: (n: number) => decodeBlock(src[n]) } as unknown as Archive;
    const destination_ = {
      channel: 'ch',
      peers: [{
        height: async () => 3,
        feed: () => ({ get: async (n: number) => ({ bytes: dst[n] }), close: () => undefined }),
      }],
      ld: { d: { peers: [{ address: 'peer0:7051', reader: { msp: 'OrgAMSP' } }] } },
    } as unknown as Destination;
    return compare(archive, destination_, 0, () => undefined);
  };

  it('matches when both sides carry the same hashes', async () => {
    expect(await run(hashes, hashes)).toMatchObject({ txBlocks: 2, differ: [], commitHashUnchecked: 0 });
  });

  it('counts source blocks without a commit hash as not checkable, not as differences', async () => {
    expect(await run(['', '', ''], hashes)).toMatchObject({ txBlocks: 2, differ: [], commitHashUnchecked: 2 });
  });

  it('reports a destination block missing the hash the source has', async () => {
    expect((await run(hashes, ['', 'aa11', ''])).differ).toEqual([{ n: 2, why: 'commit hash missing from destination' }]);
  });

  it('reports different hashes', async () => {
    expect((await run(hashes, ['', 'aa11', 'cc33'])).differ).toEqual([{ n: 2, why: 'commit hash' }]);
  });
});
