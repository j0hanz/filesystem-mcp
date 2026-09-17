import type { McpServer } from '@modelcontextprotocol/server';

import type { PathGuard } from '../core/path.ts';
import type { PageSnapshotStore, ResourceStore } from '../core/store.ts';
import { CREATE } from './create.ts';
import type { DefinedTool } from './define.ts';
import { DELETE } from './delete.ts';
import { DIFF } from './diff.ts';
import { EDIT } from './edit.ts';
import { FIND_FILES } from './find-files.ts';
import { LIST_ROOTS } from './list-roots.ts';
import { LIST } from './list.ts';
import { MOVE } from './move.ts';
import { PATCH } from './patch.ts';
import { READ } from './read.ts';
import { REPLACE_TEXT } from './replace-text.ts';
import { SEARCH_TEXT } from './search-text.ts';
import { STAT } from './stat.ts';

export const ALL_TOOLS = [
  CREATE,
  DELETE,
  DIFF,
  EDIT,
  LIST,
  MOVE,
  PATCH,
  READ,
  REPLACE_TEXT,
  LIST_ROOTS,
  SEARCH_TEXT,
  FIND_FILES,
  STAT,
] as const;

export const MUTATING_TOOL_NAMES = new Set(
  ALL_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name),
);

/** The tools a server registers at this setting — the one owner of the `--read-only` gate. */
export function registeredTools(readOnly: boolean): readonly DefinedTool[] {
  return readOnly ? ALL_TOOLS.filter((t) => !MUTATING_TOOL_NAMES.has(t.name)) : ALL_TOOLS;
}

// Re-exported so documentation surfaces quote `.name` off the definition rather
// than repeating the string. This module is the only owner of the inventory.
// Only the read-only tools are named individually: the mutating six are no
// longer listed by hand anywhere, so their names reach callers through
// MUTATING_TOOL_NAMES and ALL_TOOLS instead.
export { LIST, LIST_ROOTS, READ, SEARCH_TEXT, FIND_FILES, STAT };

interface ToolRegistrarDeps {
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly pageStore: PageSnapshotStore;
  readonly resourceStore: ResourceStore;
  readonly readOnly?: boolean;
  readonly era?: 'legacy' | 'modern';
}

export function registerTools(deps: ToolRegistrarDeps): void {
  const toolDeps = {
    server: deps.server,
    pathGuard: deps.pathGuard,
    pageStore: deps.pageStore,
    resourceStore: deps.resourceStore,
    ...(deps.era ? { era: deps.era } : {}),
  };
  for (const tool of registeredTools(deps.readOnly ?? false)) {
    tool.register(toolDeps);
  }
}
