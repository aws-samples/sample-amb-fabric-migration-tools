import { createLogger, setLogLevel } from '../src/utils/logger';

describe('logger', () => {
  /**
   * Named loggers must be children of one root, not separate pino instances: a
   * `pino-pretty` transport is a worker thread that registers a process `exit`
   * listener, so 54 `createLogger` call sites meant any command reaching ten of
   * them printed `MaxListenersExceededWarning` and interleaved lines out of
   * timestamp order on stderr.
   *
   * Asserted through prototype identity, which children share and independent
   * instances do not. The listener count itself cannot be asserted here: jest
   * sets `NODE_ENV=test`, which disables the transport that registers them, so a
   * listener assertion would pass against either implementation.
   */
  it('creates children of one shared destination, not one instance per call', () => {
    const first = createLogger('shared-root-first');
    const second = createLogger('shared-root-second');

    expect(Object.getPrototypeOf(first)).toBe(Object.getPrototypeOf(second));
  });

  it('gives each logger its own level', () => {
    const quiet = createLogger('level-quiet', 'error');
    const loud = createLogger('level-loud', 'debug');

    expect(quiet.isLevelEnabled('info')).toBe(false);
    expect(loud.isLevelEnabled('debug')).toBe(true);
  });

  it('sets the level on every logger already created', () => {
    const first = createLogger('setlevel-first');
    const second = createLogger('setlevel-second', 'debug');

    setLogLevel('silent');
    try {
      expect(first.isLevelEnabled('error')).toBe(false);
      expect(second.isLevelEnabled('error')).toBe(false);

      setLogLevel('warn');
      expect(first.isLevelEnabled('info')).toBe(false);
      expect(first.isLevelEnabled('warn')).toBe(true);
      expect(second.isLevelEnabled('warn')).toBe(true);
    } finally {
      setLogLevel(process.env.LOG_LEVEL || 'info');
    }
  });

  /**
   * Names come from a child binding now rather than from a per-instance pino
   * option, so this asserts the 54 call sites' log lines are still attributable
   * to the module that wrote them.
   */
  it('keeps the name on every record, so log lines stay attributable', () => {
    expect(createLogger('named-probe').bindings()).toEqual({
      name: 'named-probe',
    });
  });
});
