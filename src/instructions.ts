import { getMaxTextFileSize } from './core/config.ts';
import { formatByteSize } from './core/fmt.ts';
import { MAX_OUTBOUND_RESULT_BYTES } from './core/outbound.ts';
import { DEFAULT_SEARCH_CONTENT_RESULTS, MAX_SEARCH_RESULTS } from './core/util.ts';
import {
  FIND_FILES,
  LIST,
  LIST_ROOTS,
  MUTATING_TOOL_NAMES,
  READ,
  SEARCH_TEXT,
  STAT,
} from './tools/index.ts';

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
  'How to use the filesystem-mcp tools and their limits. ' +
  'Call list_roots to see the configured or accepted roots. Find paths with list or find_files, check them with stat, then read. Never guess paths.';

export function buildSectionsRecord(readOnly: boolean): Record<string, string> {
  return {
    guidelines: [
      'Guidelines:',
      '```',
      `root_access: ${LIST_ROOTS.name} lists configured or accepted roots; every other tool is scoped to them.`,
      'modern_root_grants: Modern clients do not send workspace roots. Call a tool with a concrete path and approve the grant if the client asks (elicitation).',
      `path_resolution: Confirm a path with ${LIST.name} or ${FIND_FILES.name} before acting on it.`,
      '```',
    ].join('\n'),
    tools_overview: [
      'Tools Overview:',
      buildToolsOverview(readOnly),
      '',
      'Full tool schemas are in `tools/list`.',
    ].join('\n'),
    constraints: [
      'Constraints:',
      '```',
      `allowed_roots: Startup roots come from CLI paths, FS_ALLOWED_DIRS, or --allow-cwd. Accepted modern grants add to them. Call ${LIST_ROOTS.name} to see the current set.`,
      'legacy_roots: Legacy clients can also add roots through the deprecated roots/list flow.',
      'sensitive_paths: Sensitive files are denied by default: .env, *.pem, SSH private keys (*id_rsa*, *id_ed25519*), .netrc, .git-credentials.',
      `enforced_limits: max file size ${formatByteSize(getMaxTextFileSize(), true)} (also the total content cap of one create call), stdio responses up to ${formatByteSize(MAX_OUTBOUND_RESULT_BYTES)} once JSON-encoded (HTTP has no such limit), file search returns up to ${MAX_SEARCH_RESULTS} results, content search scans up to ${MAX_SEARCH_RESULTS} matches, paged by maxResults (default ${DEFAULT_SEARCH_CONTENT_RESULTS}).`,
      'ephemeral_results: When a result has a resource_link or a resourceUri (in structuredContent or _meta), call resources/read right away. Cached results expire after about 60 seconds, on eviction, or on restart.',
      'pagination: nextCursor appears in the result text and in _meta, and its snapshot expires on the same ~60s clock. Send the printed Next page call as-is (the original arguments plus cursor). If a cursor is rejected, start again without one. resourceUri appears on the first page only.',
      '```',
    ].join('\n'),
    error_recovery: [
      'Error Recovery:',
      '```',
      `ACCESS_DENIED: Run ${LIST_ROOTS.name}. Add the missing startup root, or retry with a concrete path and approve the grant.`,
      `NOT_FOUND: Run ${LIST.name} or ${FIND_FILES.name} to check the path.`,
      `TOO_LARGE: Over the file size limit, use ${READ.name} with head/tail or startLine/endLine. Over the stdio message limit, ask for a smaller slice or page, or connect over HTTP. Media and binary files need HTTP.`,
      'TIMEOUT: Narrow the path or pattern, or lower maxDepth. maxResults only sets the page size.',
      'INVALID_INPUT: Re-read the tool schema in tools/list.',
      `BINARY_FILE: Text tools refuse binary files. ${READ.name} returns the whole file with binary: true.`,
      '```',
    ].join('\n'),
  };
}

export function renderSections(sections: Record<string, string>): string {
  return `\n${Object.values(sections).join('\n\n')}\n`;
}
