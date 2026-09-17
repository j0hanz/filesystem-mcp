import type { TextContent } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { buildSectionsRecord, renderSections } from '../src/instructions.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  type TestClientContext,
} from './helpers.ts';

describe('MCP Prompts Tests (MCP Client)', () => {
  let tmpDir: string;
  let harness: TestClientContext;
  let sections: Record<string, string>;
  let fullInstructions: string;

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createTestClientPair([tmpDir]);
    sections = buildSectionsRecord(false);
    fullInstructions = renderSections(sections);
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  describe('Prompt Definitions & Registration', () => {
    it('TC-FUNC-067: client.listPrompts() returns the get-help prompt', async () => {
      const promptsList = await harness.client.listPrompts();
      const promptNames = promptsList.prompts.map((p) => p.name);
      assert.deepEqual(promptNames, ['get-help']);

      for (const entry of promptsList.prompts) {
        assert.ok((entry.title?.length ?? 0) > 0, `Title should be defined for ${entry.name}`);
        assert.ok(
          (entry.description?.length ?? 0) > 0,
          `Description should be defined for ${entry.name}`,
        );
      }
    });

    it('TC-FUNC-067b: no argument description doubles a period', async () => {
      const promptsList = await harness.client.listPrompts();
      for (const entry of promptsList.prompts) {
        for (const arg of entry.arguments ?? []) {
          assert.ok(
            !/\w\.\.\s/u.test(arg.description ?? ''),
            `${entry.name}.${arg.name} doubles a period: ${arg.description ?? ''}`,
          );
        }
      }
    });
  });

  describe('Prompt: get-help', () => {
    it('TC-FUNC-068: Returns all instructions when no topic is provided', async () => {
      const result = await harness.client.getPrompt({ name: 'get-help', arguments: {} });

      assert.equal(result.messages.length, 1);
      const message = result.messages[0];
      assert.ok(message);
      assert.equal(message.role, 'user');
      const textContent = message.content as TextContent;
      assert.equal(textContent.type, 'text');
      assert.equal(textContent.text, fullInstructions);
      assert.ok(textContent.text.includes('Guidelines:'));
      assert.ok(textContent.text.includes('Tools Overview:'));
      assert.ok(textContent.text.includes('Constraints:'));
      assert.ok(textContent.text.includes('Error Recovery:'));
    });

    it('TC-FUNC-069: Returns filtered section for specific topic and fallback for unknown topic', async () => {
      // Specific known topic
      const guidelinesResult = await harness.client.getPrompt({
        name: 'get-help',
        arguments: { topic: 'guidelines' },
      });
      assert.equal(guidelinesResult.messages.length, 1);
      const guidelinesMessage = guidelinesResult.messages[0];
      assert.ok(guidelinesMessage);
      const guidelinesText = (guidelinesMessage.content as TextContent).text;
      assert.equal(guidelinesText, sections['guidelines']);
      assert.ok(guidelinesText.includes('root_access:'));
      assert.ok(!guidelinesText.includes('Error Recovery:'));

      // Another known topic (case-insensitive)
      const errorResult = await harness.client.getPrompt({
        name: 'get-help',
        arguments: { topic: 'ERROR_RECOVERY' },
      });
      const errorMessage = errorResult.messages[0];
      assert.ok(errorMessage);
      const errorText = (errorMessage.content as TextContent).text;
      assert.equal(errorText, sections['error_recovery']);
      assert.ok(errorText.includes('ACCESS_DENIED:'));

      // Unknown topic
      const unknownResult = await harness.client.getPrompt({
        name: 'get-help',
        arguments: { topic: 'unknown_topic_name' },
      });
      const unknownMessage = unknownResult.messages[0];
      assert.ok(unknownMessage);
      const unknownText = (unknownMessage.content as TextContent).text;
      assert.ok(unknownText.startsWith("Section 'unknown_topic_name' not found. Available:"));
      assert.ok(unknownText.includes('guidelines, tools_overview, constraints, error_recovery'));
      assert.ok(unknownText.includes(fullInstructions));
    });
  });
});
