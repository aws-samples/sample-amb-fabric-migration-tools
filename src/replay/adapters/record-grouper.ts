import {
  PublicStateRecord,
  PublicHistoryRecord,
  PrivateStateRecord,
  PrivateHistoryRecord,
  PrivateHashRecord,
  BlockMetadataRecord,
  IdentityRecord,
  ReplayRecord,
  StateDeleteRecord,
} from '../../types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('record-grouper');

export interface GroupedRecords {
  publicState: PublicStateRecord[];
  privateState: PrivateStateRecord[];
  publicHistory: PublicHistoryRecord[];
  privateHistory: PrivateHistoryRecord[];
  privateHash: PrivateHashRecord[];
  blockMetadata: BlockMetadataRecord[];
  identity: IdentityRecord[];
  stateDelete: StateDeleteRecord[];
}

/**
 * Group extraction records by their `_type` discriminator.
 *
 * All known types are grouped. Adapters that don't support a
 * particular type (e.g. DynamoDB has no privateHash table) can
 * ignore the corresponding array.
 */
export function groupByType(
  records: ReplayRecord[],
): GroupedRecords {
  const grouped: GroupedRecords = {
    publicState: [],
    privateState: [],
    publicHistory: [],
    privateHistory: [],
    privateHash: [],
    blockMetadata: [],
    identity: [],
    stateDelete: [],
  };

  for (const record of records) {
    switch (record._type) {
      case 'public_state':
        grouped.publicState.push(record as PublicStateRecord);
        break;
      case 'private_state':
        grouped.privateState.push(
          record as PrivateStateRecord,
        );
        break;
      case 'public_history':
        grouped.publicHistory.push(
          record as PublicHistoryRecord,
        );
        break;
      case 'private_history':
        grouped.privateHistory.push(
          record as PrivateHistoryRecord,
        );
        break;
      case 'private_hash':
        grouped.privateHash.push(
          record as PrivateHashRecord,
        );
        break;
      case 'block_metadata':
        grouped.blockMetadata.push(
          record as BlockMetadataRecord,
        );
        break;
      case 'identity':
        grouped.identity.push(record as IdentityRecord);
        break;
      case 'state_delete':
        grouped.stateDelete.push(record);
        break;
      default:
        logger.warn(
          { type: (record as any)._type },
          'Unknown record type in batch — skipping',
        );
    }
  }
  return grouped;
}
