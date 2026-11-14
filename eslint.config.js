/**
 * Lint gate for `src/` and `test/` — the only TypeScript in the repo.
 *
 * `tsc --noEmit` already checks types. This checks what types cannot see, and
 * in particular the two things this codebase had actually accumulated: dead
 * bindings, and `eslint-disable` comments that suppress nothing.
 *
 * Deliberately not enforced yet, with the violation count each rule reports
 * against the tree as of 2026-09-01, so the next pass starts from a number
 * rather than an intention:
 *
 *   @typescript-eslint/no-explicit-any    384   (174 src, 210 test)
 *   max-len 100                           192   (109 src,  83 test)
 *   complexity 8                           60   ( 60 src)
 *   max-lines-per-function 100             60   (  5 src,  55 test)
 *   max-params 5                            4   (  4 src)
 *
 * The first four are the limits `CLAUDE.md` states and review alone has been
 * holding. Enabling one means either satisfying it — a refactor of production
 * code, which does not belong in the commit that installs the linter — or
 * setting its threshold to whatever the tree already reports, which is not a
 * gate. They are left out rather than loosened.
 */
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    linterOptions: {
      /*
       * Default is 'warn'. At 'error' a directive that suppresses nothing fails
       * the build, which is the specific regression this gate exists to refuse:
       * five files carried `eslint-disable-next-line
       * @typescript-eslint/no-var-requires` against a rule no config enabled,
       * reading as a known exemption while exempting nothing.
       */
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      /*
       * A leading underscore marks a binding that exists to be discarded — a
       * destructuring hole, an argument a callback signature requires and the
       * body does not read. Anything unused without one is dead code.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // See the header. Most sites are the protobuf and AWS SDK boundaries,
      // where the wire type genuinely is unknown until it has been decoded.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    /*
     * `jest.mock` factories are hoisted above the imports, so a test reaches a
     * mocked export through `require()` inside the test body rather than
     * through a top-level import. The rule fires on that idiom, not on a
     * defect. It stays on for `src/`, where the six sites are justified
     * individually.
     */
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
