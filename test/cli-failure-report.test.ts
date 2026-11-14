import { reportCliFailure } from '../src/cli/index';
import { DiscoveryError, ExtractionError } from '../src/utils/errors';

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
});

afterEach(() => {
  errorSpy.mockRestore();
  process.exitCode = undefined;
});

function errorOutput(): string {
  return errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('reportCliFailure', () => {
  // Every refusal in the tool is written as a sentence naming what to change, so
  // the message is the whole point of surfacing it.
  it('prints a refusal as its message and exits 1', () => {
    reportCliFailure(
      new DiscoveryError(
        'lscc.GetCollectionsConfig failed for chaincode "mycc": access denied.',
      ),
    );

    expect(errorOutput()).toContain(
      'lscc.GetCollectionsConfig failed for chaincode "mycc": access denied.',
    );
    expect(errorOutput()).not.toContain('DiscoveryError');
    expect(process.exitCode).toBe(1);
  });

  it('handles every refusal type the commands raise', () => {
    reportCliFailure(new ExtractionError('ambFrameworkVersion is not recorded.'));

    expect(errorOutput()).toContain('ambFrameworkVersion is not recorded.');
    expect(process.exitCode).toBe(1);
  });

  // A TypeError is a defect in the tool, not something an operator can act on,
  // so it keeps its stack trace instead of being reduced to one line.
  it('re-throws anything that is not a deliberate refusal', () => {
    const bug = new TypeError('cannot read properties of undefined');

    expect(() => reportCliFailure(bug)).toThrow(bug);
    expect(errorOutput()).toBe('');
    expect(process.exitCode).toBeUndefined();
  });
});
