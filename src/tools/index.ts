import type { McpServer } from '@modelcontextprotocol/server';

import type { PageSnapshotStore } from '../core/page-store.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { CREATE } from './create.js';
import type { DefinedTool } from './define.js';
import { DELETE } from './delete.js';
import { DIFF } from './diff.js';
import { EDIT } from './edit.js';
import { FIND_FILES } from './find-files.js';
import { LIST_ROOTS } from './list-roots.js';
import { LIST } from './list.js';
import { MOVE } from './move.js';
import { PATCH } from './patch.js';
import { READ } from './read.js';
import { REPLACE_TEXT } from './replace-text.js';
import { SEARCH_TEXT } from './search-text.js';
import { STAT } from './stat.js';

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
}

export function registerTools(deps: ToolRegistrarDeps): void {
  const toolDeps = {
    server: deps.server,
    pathGuard: deps.pathGuard,
    pageStore: deps.pageStore,
    resourceStore: deps.resourceStore,
  };
  for (const tool of registeredTools(deps.readOnly ?? false)) {
    tool.register(toolDeps);
  }
}
