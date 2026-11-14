import * as fs from 'fs';
import * as path from 'path';
import { ChannelInfo, ChannelMetadata, Manifest } from '../types';
import { FileLayoutManager } from '../output/file-layout-manager';
import { ExtractionError } from '../utils/errors';

/** One member's extraction output, loaded and ready to merge. */
export interface MemberInput {
  /** Directory as passed on the command line, used verbatim in reports. */
  inputDir: string;
  manifest: Manifest;
  /** How this member is named in reports: its member ID. */
  label: string;
  /** MSP the extraction ran as. Absent when the member never recorded it. */
  mspId?: string;
  /** channelId → the channel's metadata.json, for channels that have one. */
  channelMetadata: Map<string, Partial<ChannelMetadata>>;
}

/**
 * Load every member directory named on the command line.
 *
 * `manifest.json` is mandatory rather than optional: without it the merge
 * cannot check that the members extracted the same ledger state, which is the
 * precondition the whole merge rests on. A member that shares only its private
 * files has to share its manifest and channel metadata with them.
 *
 * @param inputDirs Member extraction directories.
 * @throws ExtractionError if a directory or its manifest is missing.
 */
export function loadMembers(inputDirs: string[]): MemberInput[] {
  if (inputDirs.length < 2) {
    throw new ExtractionError(
      `merge needs at least two member directories, got ${inputDirs.length}. ` +
        'With one member there is nothing to merge — replay its output directly.',
    );
  }

  return inputDirs.map((inputDir) => loadMember(inputDir));
}

function loadMember(inputDir: string): MemberInput {
  const layout = new FileLayoutManager(inputDir);
  if (!fs.existsSync(inputDir)) {
    throw new ExtractionError(`Member directory not found: ${inputDir}`);
  }
  if (!fs.existsSync(layout.manifestPath)) {
    throw new ExtractionError(
      `No manifest.json in ${inputDir}. merge compares members' ledger ` +
        'heights and MSPs before combining them, so each member must ' +
        'contribute its manifest.json and channel-*/metadata.json alongside ' +
        'its private-*.ndjson files.',
    );
  }

  const manifest = parseJson<Manifest>(layout.manifestPath, inputDir);
  if (!Array.isArray(manifest.channels)) {
    throw new ExtractionError(
      `manifest.json in ${inputDir} has no channels array — it is not an ` +
        'extraction manifest.',
    );
  }

  return {
    inputDir,
    manifest,
    label: manifest.memberId || path.basename(path.resolve(inputDir)),
    mspId: manifest.mspId,
    channelMetadata: loadChannelMetadata(inputDir, layout, manifest.channels),
  };
}

function loadChannelMetadata(
  inputDir: string,
  layout: FileLayoutManager,
  channels: ChannelInfo[],
): Map<string, Partial<ChannelMetadata>> {
  const loaded = new Map<string, Partial<ChannelMetadata>>();
  for (const channel of channels) {
    const metadataPath = path.join(
      inputDir, layout.channelMetadataPath(channel.channelId),
    );
    if (!fs.existsSync(metadataPath)) continue;
    loaded.set(
      channel.channelId,
      parseJson<Partial<ChannelMetadata>>(metadataPath, inputDir),
    );
  }
  return loaded;
}

function parseJson<T>(filePath: string, inputDir: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    throw new ExtractionError(
      `Cannot parse ${filePath} from member ${inputDir}: ` +
        `${(err as Error).message}`,
      err as Error,
    );
  }
}

/**
 * Refuse to merge members that did not extract the same ledger state.
 *
 * Every check here runs before a single record is written, because each one
 * means the merged output would silently describe a state no member ever held.
 * A member behind on blocks does not have less data of its own kind — it has a
 * different ledger, and combining the two produces private state as of one
 * height beside public state as of another.
 *
 * @param members Loaded member inputs.
 * @throws ExtractionError naming the members and the values that disagree.
 */
export function assertMergeable(members: MemberInput[]): void {
  assertNotMerged(members);
  assertDistinct(members);
  assertNetworkAgrees(members);
  assertHeightsAgree(members);
  assertFullMemberPerChannel(members);
}

/** Whether a member extracted a channel with `--private-only`. */
export function isPrivateOnly(member: MemberInput, channelId: string): boolean {
  return member.channelMetadata.get(channelId)?.scope === 'private-only';
}

/**
 * Refuse a channel every contributing member extracted with `--private-only`.
 *
 * Such a member carries no public state, history, block metadata or private
 * hashes — those come from one full extraction of the channel, which is what
 * makes the others' work small. With none, the merged channel would have no
 * public data at all, and nothing to check any member's private values
 * against: every hash-driven check in merge and validate skips a collection
 * with no hashes, so the merge would pass while proving nothing.
 */
function assertFullMemberPerChannel(members: MemberInput[]): void {
  const uncovered = mergedChannelIds(members).filter((channelId) =>
    membersWithChannel(members, channelId)
      .every((m) => isPrivateOnly(m, channelId)));
  if (uncovered.length === 0) return;

  throw new ExtractionError(
    `No full extraction of ${uncovered.join(', ')}: every member that ` +
      'extracted it used --private-only, so the merge would hold no public ' +
      'data or private hashes for it. Add one member\'s extraction without ' +
      '--private-only for each of these channels.',
  );
}

/**
 * Reject a directory `merge` itself produced.
 *
 * A merged manifest carries `mergedFrom` in place of an `mspId`, and a member
 * is credited only with the MSP its own manifest records — so merging a merged
 * directory again credits no MSP for any member inside it. `validate` then
 * excuses every value those members should have supplied as "no extracting MSP
 * is in the collection policy", going quiet about exactly the members whose
 * coverage was rolled up. Reproduced live on a three-member AMB network: the
 * staged merge exited 0. Merging every member in one pass is always possible,
 * so there is nothing to lose by refusing.
 */
function assertNotMerged(members: MemberInput[]): void {
  const merged = members.filter((m) => m.manifest.mergedFrom?.length);
  if (merged.length === 0) return;
  throw new ExtractionError(
    `${merged.map((m) => m.inputDir).join(', ')} ` +
      `${merged.length === 1 ? 'is' : 'are'} already the output of merge. ` +
      'Merging a merged directory again credits no MSP for the members inside ' +
      'it, so validate would excuse their missing private data instead of ' +
      'reporting it. Pass every member\'s own extraction directory to one merge.',
  );
}

/**
 * Reject the same member twice.
 *
 * Duplicate records would be deduped, so the data would survive — but the
 * coverage matrix would report two members contributing values where one did,
 * and that matrix is what a go/no-go call is made from.
 */
function assertDistinct(members: MemberInput[]): void {
  const seen = new Map<string, string>();
  for (const member of members) {
    const previous = seen.get(member.label);
    if (previous) {
      throw new ExtractionError(
        `Members ${previous} and ${member.inputDir} are both member ` +
          `"${member.label}". Pass one directory per member: a member counted ` +
          'twice overstates how many members contributed values.',
      );
    }
    seen.set(member.label, member.inputDir);
  }
}

function assertNetworkAgrees(members: MemberInput[]): void {
  // stateDb is not compared: it is a property of each member's peer, which AMB lets every member choose, and
  // extraction reads blocks, so the records do not depend on it.
  for (const field of ['networkId', 'region'] as const) {
    const values = new Map<string, string>();
    for (const member of members) {
      values.set(String(member.manifest[field]), member.inputDir);
    }
    if (values.size > 1) {
      const listed = Array.from(values, ([v, dir]) => `${dir}: ${v}`);
      throw new ExtractionError(
        `Members disagree on ${field}, so they are not extractions of one ` +
          `network state — ${listed.join(', ')}.`,
      );
    }
  }
}

/**
 * Require one agreed ledger height per channel.
 *
 * Only members that actually extracted the channel are compared; a member with
 * no record of a channel simply contributes nothing to it.
 */
function assertHeightsAgree(members: MemberInput[]): void {
  const heights = new Map<string, Map<number, string[]>>();

  for (const member of members) {
    for (const channel of member.manifest.channels) {
      const perChannel =
        heights.get(channel.channelId) ?? new Map<number, string[]>();
      const dirs = perChannel.get(channel.ledgerHeight) ?? [];
      dirs.push(member.inputDir);
      perChannel.set(channel.ledgerHeight, dirs);
      heights.set(channel.channelId, perChannel);
    }
  }

  for (const [channelId, perChannel] of heights) {
    if (perChannel.size === 1) continue;
    const listed = Array.from(perChannel, ([height, dirs]) =>
      `${height} (${dirs.join(', ')})`,
    );
    throw new ExtractionError(
      `Members extracted channel ${channelId} at different ledger heights: ` +
        `${listed.join('; ')}. Re-extract the lagging members at the agreed ` +
        'height, or drop them from the merge — merging heights would pair ' +
        "one member's private data with another's public state.",
    );
  }
}

/**
 * Every channel any member extracted, in first-seen order.
 *
 * @param members Loaded member inputs.
 */
export function mergedChannelIds(members: MemberInput[]): string[] {
  const ids: string[] = [];
  for (const member of members) {
    for (const channel of member.manifest.channels) {
      if (!ids.includes(channel.channelId)) ids.push(channel.channelId);
    }
  }
  return ids;
}

/** Members that extracted a given channel. */
export function membersWithChannel(
  members: MemberInput[],
  channelId: string,
): MemberInput[] {
  return members.filter((m) =>
    m.manifest.channels.some((c) => c.channelId === channelId),
  );
}
