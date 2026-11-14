import {
  formatEndorsementRefusal,
  probePrivateEndorsements,
} from '../src/replay/endorsement-probe';
import { PrivateWriteTarget } from '../src/replay/collection-preflight';

function target(overrides: Partial<PrivateWriteTarget> = {}): PrivateWriteTarget {
  const collection = overrides.collection ?? 'col1';
  return {
    channel: 'ch1', destChannel: 'dest1', chaincode: 'mycc',
    collection, destCollection: collection, ...overrides,
  };
}

/** A contract whose endorse() succeeds or throws, recording what it was asked. */
function contract(fail?: unknown) {
  const endorse = jest.fn(async () => {
    if (fail) throw fail;
    return { submit: jest.fn() };
  });
  const newProposal = jest.fn(() => ({ endorse }));
  return { newProposal, endorse } as any;
}

/** The gateway's refusal measured live under an AND chaincode policy. */
const DISTRIBUTION = Object.assign(
  new Error('9 FAILED_PRECONDITION: requires endorsement from organisation(s) that are not in the distribution policy of the private data collection(s): [onlyA]; retry specifying trusted endorsing organizations to protect transient data'),
  { code: 9, details: [] },
);

describe('probePrivateEndorsements', () => {
  it('endorses one write per collection and submits nothing', async () => {
    const c = contract();

    const blockers = await probePrivateEndorsements(
      [target(), target({ collection: 'col2' })], () => c,
    );

    expect(blockers).toEqual([]);
    expect(c.newProposal).toHaveBeenCalledTimes(2);
    expect(c.newProposal).toHaveBeenCalledWith('ImportPrivateData', expect.objectContaining({
      // CouchDB refuses a key beginning with '_'.
      arguments: ['col1', expect.stringMatching(/^[^_]/)],
      transientData: { private_value: expect.any(Uint8Array) },
    }));
    const transaction = await c.endorse.mock.results[0].value;
    expect(transaction.submit).not.toHaveBeenCalled();
  });

  /** One probe answers for every source collection routed to the same place. */
  it('probes a destination collection once, however many sources map to it', async () => {
    const c = contract();

    await probePrivateEndorsements([
      target({ collection: 'a', destCollection: 'x' }),
      target({ collection: 'b', destCollection: 'x' }),
      target({ collection: 'a', destCollection: 'x', destChannel: 'dest2' }),
    ], () => c);

    expect(c.newProposal).toHaveBeenCalledTimes(2);
  });

  it('asks for each target\'s own contract', async () => {
    const contractFor = jest.fn(() => contract());
    const t = target({ destChannel: 'channel-d', collection: 'pairAB' });

    await probePrivateEndorsements([t], contractFor);

    expect(contractFor).toHaveBeenCalledWith(t);
  });

  it('reports every refused collection, not just the first', async () => {
    const blockers = await probePrivateEndorsements(
      [target({ collection: 'onlyA' }), target({ collection: 'allOrgs' }), target({ collection: 'pairAB' })],
      (t) => (t.collection === 'allOrgs' ? contract() : contract(DISTRIBUTION)),
    );

    expect(blockers.map((b) => b.collection)).toEqual(['onlyA', 'pairAB']);
    expect(blockers[0].planning).toBe(true);
  });

  it('quotes each endorser\'s reason when a peer refused', async () => {
    const peerRefusal = Object.assign(new Error('10 ABORTED: failed to endorse transaction'), {
      code: 10,
      details: [{ mspId: 'Org2MSP', message: 'MSP Org9MSP is not in the migration contract writer list' }],
    });

    const [blocker] = await probePrivateEndorsements([target()], () => contract(peerRefusal));

    expect(blocker.planning).toBe(false);
    expect(blocker.detail).toContain('Org2MSP: MSP Org9MSP is not in the migration contract writer list');
  });
});

describe('formatEndorsementRefusal', () => {
  it('names the collection-level endorsementPolicy remedy for a distribution refusal', () => {
    const message = formatEndorsementRefusal([
      { ...target({ collection: 'onlyA' }), detail: DISTRIBUTION.message, planning: true },
    ]);

    expect(message).toContain('ch1/mycc/onlyA on dest1');
    expect(message).toContain('nothing was submitted');
    expect(message).toContain('its own endorsementPolicy');
    expect(message).not.toContain('writer list');
  });

  it('points at the quoted peer reason for a peer refusal', () => {
    const message = formatEndorsementRefusal([
      { ...target(), detail: 'Org2MSP: denied', planning: false },
    ]);

    expect(message).toContain('writer list');
    expect(message).not.toContain('endorsementPolicy');
  });
});
