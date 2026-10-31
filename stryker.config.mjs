// Opt-in mutation audit of the path guard (not part of `npm run check`).
// Pass 1 runs only the tests that import the mutated modules; set
// STRYKER_FULL=1 to confirm survivors against the whole suite.
// Equivalent mutants are recorded in docs/mutation-triage.md.
const SCOPED_TESTS = [
  'entry-verdict',
  'guards',
  'move-exdev',
  'path-guard-grant',
  'path-helpers',
  'relocation',
  'resources',
  'scan',
  'search-literal',
  'security',
  'unicode-paths',
].map((name) => `__tests__/${name}.test.ts`);

const testCommand = process.env.STRYKER_FULL
  ? 'npm test'
  : `node --test --test-timeout=60000 ${SCOPED_TESTS.join(' ')}`;

export default {
  mutate: ['src/core/path.ts', 'src/core/sensitive.ts'],
  testRunner: 'command',
  commandRunner: { command: testCommand },
  coverageAnalysis: 'off',
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  concurrency: 2,
  reporters: ['clear-text', 'progress', 'html', 'json'],
};
