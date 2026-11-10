/**
 * @fileoverview Bundle cleanup preserves runtime skill modules while removing dependency author docs.
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { checkBundleEntries } from '../../scripts/lint-packaging.js';

describe('dependency author documentation', () => {
  const authorDocs = [
    'node_modules/pkg/skills/example/SKILL.md',
    'node_modules/@scope/pkg/framework-skills/example/SKILL.md',
    'node_modules/pkg/.claude/settings.json',
    'node_modules/pkg/.agents/skills/example/SKILL.md',
    'node_modules/pkg/SKILL.md',
    'node_modules/pkg/dist/SKILL.md',
    'node_modules/pkg/AGENTS.md',
    'node_modules/@scope/pkg/CLAUDE.md',
    'node_modules/@outer/pkg/node_modules/@inner/pkg/skills/example/SKILL.md',
    'node_modules/pkg/node_modules/inner/node_modules/deep/.agents/config.json',
  ];

  it('removes package-root author docs, including nested scoped dependencies', () => {
    expect(filterAgentDocEntries(authorDocs)).toEqual(authorDocs);
    expect(checkBundleEntries(authorDocs, 'fixture.mcpb')).toHaveLength(1);
  });

  it('preserves runtime modules and published root skills', () => {
    const runtime = [
      'skills/gdelt/SKILL.md',
      'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
      'node_modules/@modelcontextprotocol/sdk/dist/esm/ext/skills/index.js',
      'node_modules/@modelcontextprotocol/sdk/dist/cjs/ext/skills/loader.js',
      'node_modules/outer/node_modules/@scope/pkg/dist/skills/index.js',
      'node_modules/pkg/lib/framework-skills/index.js',
      'node_modules/pkg/dist/.claude/runtime.js',
      'node_modules/pkg/dist/.agents/runtime.js',
      'node_modules/pkg/dist/AGENTS.md',
    ];
    expect(filterAgentDocEntries(runtime)).toEqual([]);
    expect(checkBundleEntries(runtime, 'fixture.mcpb')).toEqual([]);
  });
});
