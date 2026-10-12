/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import {describe, it} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {executablePath} from 'puppeteer';

import type {ToolDefinition} from '../src/tools/ToolDefinition';

describe('e2e', () => {
  async function withClient(
    cb: (client: Client) => Promise<void>,
    extraArgs: string[] = [],
  ) {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [
        'build/src/index.js',
        '--headless',
        '--no-usage-statistics',
        '--isolated',
        '--executable-path',
        executablePath(),
        ...extraArgs,
      ],
    });
    const client = new Client(
      {
        name: 'e2e-test',
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport);
      await cb(client);
    } finally {
      await client.close();
    }
  }
  it('calls a tool', async () => {
    await withClient(async client => {
      const result = await client.callTool({
        name: 'list_pages',
        arguments: {},
      });
      assert.deepStrictEqual(result, {
        content: [
          {
            type: 'text',
            text: '# list_pages response\n## Pages\n1: about:blank [selected]',
          },
        ],
      });
    });
  });

  it('calls a tool multiple times', async () => {
    await withClient(async client => {
      let result = await client.callTool({
        name: 'list_pages',
        arguments: {},
      });
      result = await client.callTool({
        name: 'list_pages',
        arguments: {},
      });
      assert.deepStrictEqual(result, {
        content: [
          {
            type: 'text',
            text: '# list_pages response\n## Pages\n1: about:blank [selected]',
          },
        ],
      });
    });
  });

  it('atomically targets concurrent actions and preserves legacy numeric selection', async () => {
    await withClient(
      async client => {
        const first = await client.callTool({
          name: 'list_pages',
          arguments: {},
        });
        const firstTarget = (first.structuredContent as {target: {id: string}})
          .target;
        const created = await client.callTool({
          name: 'new_page',
          arguments: {url: 'about:blank'},
        });
        const secondTarget = (
          created.structuredContent as {target: {id: string}}
        ).target;
        assert.notEqual(firstTarget.id, secondTarget.id);
        const calls = await Promise.all(
          [firstTarget.id, secondTarget.id].map((targetId, index) =>
            client.callTool({
              name: 'evaluate_script',
              arguments: {
                targetId,
                function: `() => { document.title = "owned-${index}"; return document.title; }`,
              },
            }),
          ),
        );
        assert.deepEqual(
          calls.map(
            result =>
              (result.structuredContent as {target: {id: string}}).target.id,
          ),
          [firstTarget.id, secondTarget.id],
        );
        for (const [index, target] of [firstTarget, secondTarget].entries()) {
          const readback = await client.callTool({
            name: 'evaluate_script',
            arguments: {targetId: target.id, function: '() => document.title'},
          });
          assert.match(
            JSON.stringify(readback.content),
            new RegExp(`owned-${index}`),
          );
        }
        await client.callTool({name: 'select_page', arguments: {pageId: 1}});
        const legacy = await client.callTool({
          name: 'evaluate_script',
          arguments: {function: '() => document.title'},
        });
        assert.match(JSON.stringify(legacy.content), /owned-0/);
        await client.callTool({name: 'close_page', arguments: {pageId: 2}});
        const closed = await client.callTool({
          name: 'evaluate_script',
          arguments: {
            targetId: secondTarget.id,
            function: '() => { document.title = "MUST-NOT-RUN"; }',
          },
        });
        assert.equal(closed.isError, true);
        const unchanged = await client.callTool({
          name: 'evaluate_script',
          arguments: {function: '() => document.title'},
        });
        assert.match(JSON.stringify(unchanged.content), /owned-0/);
      },
      ['--experimental-structured-content'],
    );
  });

  it('has all tools', async () => {
    await withClient(async client => {
      const {tools} = await client.listTools();
      const exposedNames = tools.map(t => t.name).sort();
      const files = fs.readdirSync('build/src/tools');
      const definedNames = [];
      for (const file of files) {
        if (file === 'ToolDefinition.js') {
          continue;
        }
        const fileTools = await import(`../src/tools/${file}`);
        for (const maybeTool of Object.values<ToolDefinition>(fileTools)) {
          if ('name' in maybeTool) {
            if (maybeTool.annotations?.conditions) {
              continue;
            }
            definedNames.push(maybeTool.name);
          }
        }
      }
      definedNames.sort();
      assert.deepStrictEqual(exposedNames, definedNames);
    });
  });

  it('has experimental extensions tools', async () => {
    await withClient(
      async client => {
        const {tools} = await client.listTools();
        const clickAt = tools.find(t => t.name === 'install_extension');
        assert.ok(clickAt);
      },
      ['--category-extensions'],
    );
  });

  it('has experimental vision tools', async () => {
    await withClient(
      async client => {
        const {tools} = await client.listTools();
        const clickAt = tools.find(t => t.name === 'click_at');
        assert.ok(clickAt);
      },
      ['--experimental-vision'],
    );
  });

  it('has experimental interop tools', async () => {
    await withClient(
      async client => {
        const {tools} = await client.listTools();
        const getTabId = tools.find(t => t.name === 'get_tab_id');
        assert.ok(getTabId);
      },
      ['--experimental-interop-tools'],
    );
  });
});
