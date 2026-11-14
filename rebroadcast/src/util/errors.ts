/**
 * Exit codes (design §6.5). Every refusal the tool makes carries one, so a script or an operator can tell
 * "nothing was sent" from "the destination may now differ".
 */
export enum Exit {
  Ok = 0,
  Usage = 1,
  Blocking = 2,
  Rejected = 3,
  BroadcastFailed = 4,
  MovedWhileIdle = 5,
  Mismatch = 6,
  DestinationAhead = 7,
  Unaligned = 8,
  ChannelName = 9,
  SignaturesMissing = 10,
  Unreachable = 11,
  SignOffMissing = 12,
  /** The destination, or a peer, has not committed every block yet. */
  Behind = 13,
}

export class RbError extends Error {
  constructor(
    readonly code: Exit,
    message: string,
  ) {
    super(message);
    this.name = 'RbError';
  }
}

export const fail = (code: Exit, message: string): never => {
  throw new RbError(code, message);
};
