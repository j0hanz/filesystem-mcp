import type {
  GetPromptResult,
  McpServer,
  PromptMessage,
  TextContent,
} from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { Logger } from './core/observability.js';
import { buildSectionsRecord, INSTRUCTIONS_SUMMARY, renderSections } from './instructions.js';

// --- Types ---

interface PromptRegistrarDeps {
  readonly server: McpServer;
  readonly readOnly?: boolean;
}

// --- Helpers ---

function topicArg(
  topics: readonly string[],
  description: string,
): ReturnType<typeof completable<z.ZodString>> {
  return completable(
    // No content validation beyond non-empty: the handler resolves a topic by
    // `Object.hasOwn` against a frozen record, so anything unrecognized already
    // falls through to the not-found reply without reaching an interpreter.
    z.string().min(1, { message: 'Topic required' }).describe(description),
    (value) => {
      const lower = value.toLowerCase();
      return lower ? topics.filter((t) => t.startsWith(lower)) : [...topics];
    },
  );
}

function userText(text: string): PromptMessage {
  const content: TextContent = {
    type: 'text',
    text,
    annotations: { audience: ['assistant'], priority: 1 },
  };
  return { role: 'user', content };
}

// --- Prompt entries ---

export function registerPrompts(deps: PromptRegistrarDeps): void {
  const sections = buildSectionsRecord(deps.readOnly ?? false);
  const instructions = renderSections(sections);
  const topics = Object.keys(sections);

  deps.server.registerPrompt(
    'get-help',
    {
      title: 'Get Help',
      description: INSTRUCTIONS_SUMMARY,
      argsSchema: z.strictObject({
        topic: topicArg(
          topics,
          `Section key to filter instructions (one of: ${topics.join(', ')}); omit to return all instructions.`,
        ).optional(),
      }),
    },
    ({ topic }: { topic?: string | undefined }): GetPromptResult => {
      const lowerTopic = topic?.toLowerCase();
      const section =
        lowerTopic && Object.hasOwn(sections, lowerTopic) ? sections[lowerTopic] : undefined;
      if (topic && !section) {
        Logger.debug('get-help: unknown topic requested', { topic });
      }
      const text =
        section ??
        (topic
          ? `Section '${topic}' not found. Available: ${topics.join(', ')}\n\n${instructions}`
          : instructions);
      return {
        description: INSTRUCTIONS_SUMMARY,
        messages: [userText(text)],
      };
    },
  );
}
