import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  getMaxTextFileSize,
  MAX_SEARCH_RESULTS,
} from './core/util.js';
import {
  FIND_FILES,
  LIST,
  LIST_ROOTS,
  MUTATING_TOOL_NAMES,
  READ,
  SEARCH_TEXT,
  STAT,
} from './tools/index.js';

function buildToolsOverview(readOnly: boolean): string {
  const rows: [string, string[]][] = [
    ['Navigate', [LIST_ROOTS.name, LIST.name, FIND_FILES.name]],
    ['Inspect', [STAT.name, SEARCH_TEXT.name]],
    ['Read', [READ.name]],
  ];

  // Under --read-only the mutating tools are never registered, so advertising
  // them here would point the model at tools that are not there. Drop the row
  // rather than emit an empty one.
  if (!readOnly) {
    rows.push(['Write', [...MUTATING_TOOL_NAMES]]);
  }

  const rowLines = rows.map(([cat, names]) => `${cat}: ${names.join(', ')}`);
  return `\`\`\`\n${rowLines.join('\n')}\n\`\`\``;
}

export const INSTRUCTIONS_URI = 'internal://instructions';

/**
 * The one statement of what this server is and how to approach it. The server's
 * `instructions`, the `get-help` prompt, and the instructions resource all
 * describe the same document, and three hand-maintained paraphrases of it drift
 * against each other and cost the client the same sentence three times.
 */
export const INSTRUCTIONS_SUMMARY =
  'Navigation guide for filesystem-mcp tools and constraints. ' +
  'Use list_roots to inspect configured or accepted roots, then list/find_files -> stat -> read. Never guess paths.';

export function buildSectionsRecord(readOnly: boolean): Record<string, string> {
  const maxFileMb = Math.floor(getMaxTextFileSize() / 1024 / 1024);
  return {
    guidelines: [
      'Guidelines:',
      '```',
      `root_access: ${LIST_ROOTS.name} lists configured or accepted roots; every other tool is scoped to them.`,
      'modern_root_grants: Modern clients do not automatically send workspace roots. Call a tool with a concrete path and approve its grant when elicitation is available.',
      `path_resolution: Confirm a path with ${LIST.name} or ${FIND_FILES.name} before acting on it.`,
      '```',
    ].join('\n'),
    tools_overview: [
      'Tools Overview:',
      buildToolsOverview(readOnly),
      '',
      'Full schemas, descriptions, and annotations are in `tools/list`.',
    ].join('\n'),
    constraints: [
      'Constraints:',
      '```',
      `allowed_roots: Startup roots come from CLI paths, FS_ALLOWED_DIRS, or --allow-cwd; accepted modern grants are additive. Call ${LIST_ROOTS.name} to read the current set.`,
      'legacy_roots: Legacy clients may additionally seed roots through the deprecated roots/list flow.',
      'sensitive_paths: Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.',
      `enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.`,
      'ephemeral_results: When a result carries a resource_link or a resourceUri (in structuredContent or _meta), call resources/read immediately — cached results are ephemeral and expire after ~60 seconds, eviction, or restart.',
      'pagination: nextCursor appears in the result text and in _meta, backed by a snapshot on the same ~60s clock. Page through promptly; if a cursor is rejected, start again without one. resourceUri appears on the first page only.',
      '```',
    ].join('\n'),
    error_recovery: [
      'Error Recovery:',
      '```',
      `ACCESS_DENIED: Run ${LIST_ROOTS.name}; configure a missing startup root or retry a concrete path and approve the grant.`,
      `NOT_FOUND: Run ${LIST.name} or ${FIND_FILES.name} to verify the path.`,
      `TOO_LARGE: Use ${READ.name} with head/tail or startLine/endLine, or split across several calls.`,
      'TIMEOUT: Reduce scope, depth, or maxResults.',
      'INVALID_INPUT: Re-read the tool schema in tools/list.',
      '```',
    ].join('\n'),
  };
}

export function renderSections(sections: Record<string, string>): string {
  return `\n${Object.values(sections).join('\n\n')}\n`;
}
