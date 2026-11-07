// Worker entry for diffs too big to run on the event loop (see core/diff.ts).
import { parentPort } from 'node:worker_threads';

import { structuredPatch } from 'diff';

export interface DiffWorkerRequest {
  oldName: string;
  newName: string;
  before: string;
  after: string;
  oldHeader: string;
  newHeader: string;
  options: { context?: number; timeout: number };
}

parentPort?.on('message', (req: DiffWorkerRequest) => {
  const patch = structuredPatch(
    req.oldName,
    req.newName,
    req.before,
    req.after,
    req.oldHeader,
    req.newHeader,
    req.options,
  );
  parentPort?.postMessage(patch ?? null);
});
