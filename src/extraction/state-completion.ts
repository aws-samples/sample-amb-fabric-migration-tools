// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { FileLayoutManager } from '../output/file-layout-manager';

export const STATE_RECONSTRUCTION_COMPLETE = 'state-reconstruction.complete';

export function stateReconstructionCompletePath(
  outputDir: string,
  layout: FileLayoutManager,
  channelId: string,
): string {
  return path.join(
    outputDir,
    layout.checkpointDir(channelId),
    STATE_RECONSTRUCTION_COMPLETE,
  );
}

/** Mark a fresh channel extraction complete only after every NDJSON stream has closed. */
export function markStateReconstructionComplete(
  outputDir: string,
  layout: FileLayoutManager,
  channelId: string,
): void {
  const marker = stateReconstructionCompletePath(outputDir, layout, channelId);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  const tmp = marker + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ channelId }) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, marker);
  const dirFd = fs.openSync(path.dirname(marker), 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}
