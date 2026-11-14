import { ReplayConfig } from '../types';
import { ExtractorError } from '../utils/errors';

/**
 * Which destination channel each source channel's records travel to.
 *
 * Two config forms answer this. `channelMapping` names a destination per source
 * channel; `channel` names one destination for the whole run. The shorthand is
 * only meaningful when the run carries a single source channel — given more, it
 * collapses them, and two channels' copies of one key overwrite each other in
 * whatever order their files happen to be replayed. A migration of
 * eight channels would have become one channel holding the last writer of every
 * shared key, with no error anywhere.
 *
 * `replay` and `verify` both need the answer, and a disagreement between them
 * writes to one channel and reads back from another, so it is derived here once.
 * What to do about a source channel with no destination differs between them and
 * stays with each: `replay` warns and skips it, `verify` refuses.
 */

/** One source channel and the destination channel it is routed to. */
export interface ChannelRoute {
  /** Source channel, as named in the manifest. */
  channel: string;
  /** Destination channel to write to and read back from. */
  destChannel: string;
}

/** Every in-scope source channel, split by whether it has a destination. */
export interface ChannelRouting {
  /** Source channels with a destination, in the order they were given. */
  routes: ChannelRoute[];
  /** Source channels `channelMapping` has no entry for. */
  unroutedChannels: string[];
}

/**
 * Route each in-scope source channel to its destination channel.
 *
 * @param ccConfig Chaincode section of the replay config.
 * @param sourceChannels Source channels this run covers — the manifest's, or the
 *   subset a `--channels` flag narrowed it to.
 * @returns The routes, and the in-scope channels left without one.
 * @throws ExtractorError when the config cannot route the run without merging
 *   channels: no destination at all, both forms at once, `channel` with more
 *   than one source channel in scope, or a `channelMapping` that sends two of
 *   them to the same destination.
 */
export function resolveChannelRouting(
  ccConfig: NonNullable<ReplayConfig['chaincode']>,
  sourceChannels: string[],
): ChannelRouting {
  const { channel, channelMapping } = ccConfig;

  if (channel && channelMapping) {
    throw new ExtractorError(
      'chaincode.channel and chaincode.channelMapping are both set, and they ' +
      'disagree about where a source channel goes. Keep channelMapping, which ' +
      'says it per channel, and delete channel.',
      'CHANNEL_ROUTING_ERROR',
    );
  }
  if (channelMapping) return mappedRouting(channelMapping, sourceChannels);
  if (channel) return singleRouting(channel, sourceChannels);

  throw new ExtractorError(
    'Either channel (one destination, for a single-channel run) or ' +
    'channelMapping (source channel → destination channel) is required in ' +
    'the chaincode config.',
    'CHANNEL_ROUTING_ERROR',
  );
}

/** Route by explicit per-channel mapping, refusing a mapping that merges. */
function mappedRouting(
  channelMapping: Record<string, string>,
  sourceChannels: string[],
): ChannelRouting {
  const routes: ChannelRoute[] = [];
  const unroutedChannels: string[] = [];

  for (const channel of sourceChannels) {
    const destChannel = channelMapping[channel];
    if (destChannel) routes.push({ channel, destChannel });
    else unroutedChannels.push(channel);
  }

  const merges = mergedDestinations(routes);
  if (merges.length > 0) {
    throw new ExtractorError(
      'chaincode.channelMapping sends more than one source channel to the ' +
      `same destination channel: ${merges.join('; ')}. Each destination ` +
      'channel is one ledger, so the two channels\' copies of a shared key ' +
      'overwrite each other there and the survivor is whichever file was ' +
      'replayed last. Give each source channel its own destination channel.',
      'CHANNEL_ROUTING_ERROR',
    );
  }

  return { routes, unroutedChannels };
}

/** Route every source channel to one destination, refusing to merge them. */
function singleRouting(
  channel: string,
  sourceChannels: string[],
): ChannelRouting {
  if (sourceChannels.length > 1) {
    throw new ExtractorError(
      `chaincode.channel sends every source channel to "${channel}", and ` +
      `this run covers ${sourceChannels.length} of them: ` +
      `${sourceChannels.join(', ')}. Their copies of a shared key would ` +
      'overwrite each other on that one ledger, leaving one channel\'s data ' +
      'and reporting no failure. Replace channel with a channelMapping entry ' +
      'per source channel, or narrow the run to a single channel with ' +
      '--channels.',
      'CHANNEL_ROUTING_ERROR',
    );
  }

  return {
    routes: sourceChannels.map((source) => ({
      channel: source,
      destChannel: channel,
    })),
    unroutedChannels: [],
  };
}

/** Destinations that more than one in-scope source channel is routed to. */
function mergedDestinations(routes: ChannelRoute[]): string[] {
  const sourcesByDest = new Map<string, string[]>();
  for (const { channel, destChannel } of routes) {
    const sources = sourcesByDest.get(destChannel);
    if (sources) sources.push(channel);
    else sourcesByDest.set(destChannel, [channel]);
  }

  return Array.from(sourcesByDest)
    .filter(([, sources]) => sources.length > 1)
    .map(([destChannel, sources]) => `${sources.join(' + ')} → ${destChannel}`);
}
