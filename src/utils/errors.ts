// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

export class ExtractorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'ExtractorError';
  }
}

export class ConnectionError extends ExtractorError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONNECTION_ERROR', cause);
    this.name = 'ConnectionError';
  }
}

export class DiscoveryError extends ExtractorError {
  constructor(message: string, cause?: Error) {
    super(message, 'DISCOVERY_ERROR', cause);
    this.name = 'DiscoveryError';
  }
}

export class ExtractionError extends ExtractorError {
  constructor(message: string, cause?: Error) {
    super(message, 'EXTRACTION_ERROR', cause);
    this.name = 'ExtractionError';
  }
}

export class ReplayError extends ExtractorError {
  constructor(message: string, cause?: Error) {
    super(message, 'REPLAY_ERROR', cause);
    this.name = 'ReplayError';
  }
}

export class CheckpointError extends ExtractorError {
  constructor(message: string, cause?: Error) {
    super(message, 'CHECKPOINT_ERROR', cause);
    this.name = 'CheckpointError';
  }
}

export class ChaincodeError extends ExtractorError {
  constructor(message: string, cause?: Error) {
    super(message, 'CHAINCODE_ERROR', cause);
    this.name = 'ChaincodeError';
  }
}
