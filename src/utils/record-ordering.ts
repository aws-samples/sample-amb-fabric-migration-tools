// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Describes a monotonicity violation in record ordering.
 */
export interface OrderingViolation {
  type: 'block' | 'tx';
  prevBlock: number;
  currentBlock: number;
  prevTxIndex: number;
  currentTxIndex: number;
}

/**
 * Stateful checker for monotonically non-decreasing
 * blockNumber / txIndex ordering in a record stream.
 *
 * Call `check()` for each record in sequence. It returns
 * a violation descriptor if ordering is broken, null otherwise.
 * Internal state always advances regardless of violations.
 */
export class RecordOrderingChecker {
  private prevBlock = -1;
  private prevTxIndex = -1;

  check(
    blockNumber: number,
    txIndex: number,
  ): OrderingViolation | null {
    let violation: OrderingViolation | null = null;

    if (blockNumber < this.prevBlock) {
      violation = {
        type: 'block',
        prevBlock: this.prevBlock,
        currentBlock: blockNumber,
        prevTxIndex: this.prevTxIndex,
        currentTxIndex: txIndex,
      };
    } else if (
      blockNumber === this.prevBlock &&
      txIndex < this.prevTxIndex
    ) {
      violation = {
        type: 'tx',
        prevBlock: this.prevBlock,
        currentBlock: blockNumber,
        prevTxIndex: this.prevTxIndex,
        currentTxIndex: txIndex,
      };
    }

    if (blockNumber !== this.prevBlock) {
      this.prevTxIndex = txIndex;
    } else {
      this.prevTxIndex = Math.max(this.prevTxIndex, txIndex);
    }
    this.prevBlock = Math.max(this.prevBlock, blockNumber);

    return violation;
  }
}
