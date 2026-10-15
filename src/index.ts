#!/usr/bin/env node
// The process entry. On a Node.js line that lacks an API the server imports, a
// static import of the server fails while the modules link, before any code
// here could explain why. So the version check runs first and the server loads
// dynamically after it. Keep this file's static imports to modules that load
// on any Node.js version.
import process from 'node:process';

import { checkNodeVersion } from './node-version.ts';

const { fatal, warning } = checkNodeVersion(process.version);
if (fatal !== undefined) {
  console.error(fatal);
  process.exitCode = 1;
} else {
  if (warning !== undefined) console.error(warning);
  await import('./main.ts');
}
