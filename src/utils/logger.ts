import pino from 'pino';

/**
 * The one transport for the process, shared by every named logger.
 *
 * A `pino-pretty` transport is a worker thread that registers a process `exit`
 * listener, so building one per `createLogger` call registered one listener per
 * call. 54 call sites means any command whose import graph reaches ten of them
 * printed Node's `MaxListenersExceededWarning`, and the independent workers
 * interleaved lines out of timestamp order on stderr. Named loggers are children
 * of this root instead: one worker, one listener, one ordered stream.
 */
const pretty =
  process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';

/**
 * Logs go to stderr, always. stdout carries command output — `verify --output
 * json` promises one JSON object per line on it — and a log line interleaved
 * there made that stream unparseable.
 */
const root = pretty
  ? pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, destination: 2 },
    },
  })
  : pino({ level: process.env.LOG_LEVEL || 'info' }, pino.destination(2));

const registry: pino.Logger[] = [root];

export function createLogger(
  name: string,
  level = process.env.LOG_LEVEL || 'info',
): pino.Logger {
  const instance = root.child({ name }, { level });
  registry.push(instance);
  return instance;
}

/** Set the level on every logger created via `createLogger()`. */
export function setLogLevel(level: string): void {
  for (const l of registry) {
    l.level = level;
  }
}

export const logger = createLogger('fabric-amb-extractor');
