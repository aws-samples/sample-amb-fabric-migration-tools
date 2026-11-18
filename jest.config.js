// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

process.env.NODE_ENV = 'test';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // `src` is here for coverage, not for tests. With `test` alone the crawler
  // never visits the source tree, so `collectCoverageFrom` can only report
  // files some test happened to import: 12 files no test touches went missing
  // from the totals, and the numbers read 10 points higher than they were.
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts'],
  // Each number is the point at which a named regression fails, not the number
  // the suite happens to report. The headroom in units is what makes it a gate:
  // a global percentage over 6,757 statements can absorb a whole subsystem
  // going dark, so the directories where silent failures would hide are gated
  // separately, and jest removes them from the global group.
  coverageThreshold: {
    // 30 statements and 15 branches of headroom, which is about one adapter
    // method or one resume branch. This is the directory where a replay path
    // going dark is a silent no-op rather than a crash — `run()` itself was
    // once uncovered.
    './src/replay/': { statements: 95, branches: 90 },
    // 4 branches of headroom, deliberately the tightest here: in verify-runner
    // the branches *are* the skip paths, and a skip that nothing exercises is
    // the defect class this suite exists for — a check that reports success without
    // running. A new skip reason arriving untested has to fail this.
    './src/verification/': { statements: 95, branches: 85 },
    // 20 statements and 15 branches. Lower than the two above because the
    // decode paths for block versions this repo cannot obtain are unreachable
    // from any test; 70 is above what those account for, so it still refuses a
    // reachable branch going dark.
    './src/extraction/': { statements: 90, branches: 70 },
    // Everything else, and the only regression a number this coarse can refuse:
    // another untested layer, a few hundred statements at zero coverage. It is deliberately loose — one file added
    // ahead of its tests should not fail CI, a subsystem added without any
    // should.
    global: { statements: 55, branches: 43 },
  },
};
