// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  countNdjsonLines,
  lineReadBuffer,
  readLineAt,
  scanNdjsonLines,
} from '../src/output/ndjson-scan';

// ── Reading NDJSON without holding it ──
//
// Row 3.6. Everything here works in bytes because the files can be larger than
// the longest string Node will make, so the things worth testing are the ones a
// whole-file read got for free: a line split across two reads, an offset that
// still points at the line it was recorded for, and a last line with no newline
// after it.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-scan-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write `content` verbatim — no trailing newline is added. */
function write(content: string | Buffer, name = 'f.ndjson'): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function scan(
  filePath: string,
): Promise<Array<{ offset: number; text: string }>> {
  const lines: Array<{ offset: number; text: string }> = [];
  for await (const line of scanNdjsonLines(filePath)) {
    lines.push({ offset: line.offset, text: line.bytes.toString('utf-8') });
  }
  return lines;
}

describe('scanNdjsonLines', () => {
  test('yields each line with the offset it starts at', async () => {
    const lines = await scan(write('aa\nbbbb\nc\n'));

    expect(lines).toEqual([
      { offset: 0, text: 'aa' },
      { offset: 3, text: 'bbbb' },
      { offset: 8, text: 'c' },
    ]);
  });

  test('a final newline does not produce a trailing empty line', async () => {
    expect(await scan(write('a\nb\n'))).toHaveLength(2);
  });

  test('a last line with no newline after it is still yielded', async () => {
    // What every file this tool writes looks like while it is being written,
    // and what the fixtures in the other suites look like always.
    const lines = await scan(write('a\nbb'));

    expect(lines).toEqual([
      { offset: 0, text: 'a' },
      { offset: 2, text: 'bb' },
    ]);
  });

  test('an empty file yields nothing', async () => {
    expect(await scan(write(''))).toEqual([]);
  });

  test('blank lines are yielded, so a line number stays a line number',
    async () => {
      // A caller reporting "line 3 is not valid JSON" counts what it was
      // given. Dropping blanks here would shift every number after one.
      const lines = await scan(write('a\n\nb\n'));

      expect(lines.map((l) => l.text)).toEqual(['a', '', 'b']);
    });

  test('a line longer than one read is joined before it is yielded', async () => {
    // The stream reads 64 KiB at a time, so this line arrives in pieces and a
    // reader that yielded each piece would hand out fragments of a record.
    const long = 'x'.repeat(200_000);
    const lines = await scan(write(`first\n${long}\nlast`));

    expect(lines.map((l) => l.text.length)).toEqual([5, 200_000, 4]);
    expect(lines.map((l) => l.offset)).toEqual([0, 6, 200_007]);
  });

  test('a line ending exactly at a read boundary is not merged with the next',
    async () => {
      const filled = 'y'.repeat(64 * 1024 - 1);
      const lines = await scan(write(`${filled}\nnext`));

      expect(lines.map((l) => l.text)).toEqual([filled, 'next']);
    });

  test('offsets count bytes, not characters', async () => {
    // A multi-byte character makes the two differ, and an offset that counted
    // characters would read the following line from the wrong place.
    const filePath = write('é\nnext\n');
    const lines = await scan(filePath);

    expect(lines.map((l) => l.offset)).toEqual([0, 3]);
    expect(lines[1].text).toBe('next');
  });

  test('a multi-byte character split across reads is decoded whole', async () => {
    // 0x0A never appears inside a UTF-8 sequence, so splitting on the byte is
    // safe — but only if the bytes are joined before they are decoded.
    const pad = 'z'.repeat(64 * 1024 - 1);
    const lines = await scan(write(Buffer.from(`${pad}é\n`, 'utf-8')));

    expect(lines[0].text).toBe(`${pad}é`);
  });
});

describe('countNdjsonLines', () => {
  test('counts records, not lines', async () => {
    const content = 'a\n\nb\n\n\nc';
    const filePath = write(content);

    // The count this replaced, kept as the thing it has to agree with.
    expect(await countNdjsonLines(filePath))
      .toBe(content.split('\n').filter(Boolean).length);
    expect(await countNdjsonLines(filePath)).toBe(3);
  });

  test('an empty file has no records', async () => {
    expect(await countNdjsonLines(write(''))).toBe(0);
  });

  test('a file of only newlines has no records', async () => {
    expect(await countNdjsonLines(write('\n\n\n'))).toBe(0);
  });
});

describe('readLineAt', () => {
  /** Read every line back by the offset the scan reported for it. */
  async function readBackByOffset(
    filePath: string,
    scratch: Buffer,
  ): Promise<string[]> {
    const offsets = (await scan(filePath)).map((l) => l.offset);
    const fd = fs.openSync(filePath, 'r');
    try {
      return offsets.map((offset) => readLineAt(fd, offset, scratch));
    } finally {
      fs.closeSync(fd);
    }
  }

  test('returns the line the offset was recorded for', async () => {
    const filePath = write('{"a":1}\n{"b":2}\n{"c":3}\n');

    expect(await readBackByOffset(filePath, lineReadBuffer()))
      .toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test('reads a line longer than the scratch buffer', async () => {
    // The buffer is a read size, not a line limit: a value larger than it has
    // to come back whole or a comparison against it is meaningless.
    const long = 'x'.repeat(200_000);
    const filePath = write(`short\n${long}\n`);

    expect(await readBackByOffset(filePath, lineReadBuffer()))
      .toEqual(['short', long]);
  });

  test('a one-byte buffer reads whole lines too', async () => {
    // Nothing in the loop depends on the buffer being large enough, and a test
    // that only ever reads in one go would not show that.
    const filePath = write('hello\nworld\n');

    expect(await readBackByOffset(filePath, Buffer.allocUnsafe(1)))
      .toEqual(['hello', 'world']);
  });

  test('reads a last line that has no newline after it', async () => {
    const filePath = write('a\nunterminated');

    expect(await readBackByOffset(filePath, lineReadBuffer()))
      .toEqual(['a', 'unterminated']);
  });

  test('an offset past the end of the file reads as empty', async () => {
    // What a caller sees when the file it indexed was replaced by a shorter
    // one. Empty is not a record, so the caller can say so.
    const filePath = write('a\n');
    const fd = fs.openSync(filePath, 'r');
    try {
      expect(readLineAt(fd, 4096, lineReadBuffer())).toBe('');
    } finally {
      fs.closeSync(fd);
    }
  });

  test('decodes multi-byte characters that span two reads', async () => {
    const pad = 'z'.repeat(64 * 1024 - 1);
    const filePath = write(Buffer.from(`${pad}é\n`, 'utf-8'));
    const fd = fs.openSync(filePath, 'r');
    try {
      expect(readLineAt(fd, 0, lineReadBuffer())).toBe(`${pad}é`);
    } finally {
      fs.closeSync(fd);
    }
  });
});
