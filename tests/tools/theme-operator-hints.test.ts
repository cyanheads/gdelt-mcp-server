/**
 * @fileoverview Pins how the tool surface advertises the DOC `theme:` query operator: every DOC
 * tool's `query` names the operator and the tool that finds its identifiers, and every
 * `theme:<ID>` example anywhere on the surface is an identifier GDELT's GKG theme lookup lists.
 * @module tests/tools/theme-operator-hints.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';

const DOC_TOOLS = [
  definitions.gdeltSearchArticles,
  definitions.gdeltGetCoverageTimeline,
  definitions.gdeltGetToneDistribution,
  definitions.gdeltGetCoverageBreakdown,
];

/** Identifiers of the real lookup lines copied into the excerpt fixture. */
const LOOKUP_THEMES = new Set(
  readFileSync(new URL('../fixtures/gkg-themes-excerpt.txt', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')[0]),
);

function queryDescription(definition: (typeof DOC_TOOLS)[number]): string {
  return definition.input.shape.query.description ?? '';
}

/** Every piece of text a tool advertises: description, both schemas, and its error contract. */
function advertisedText(definition: {
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  errors?: unknown;
}): string {
  return [
    definition.description,
    JSON.stringify(z.toJSONSchema(definition.input)),
    JSON.stringify(z.toJSONSchema(definition.output)),
    JSON.stringify(definition.errors ?? []),
  ].join('\n');
}

describe('theme: operator hints', () => {
  it.each(DOC_TOOLS.map((d) => [d.name, d] as const))(
    '%s advertises the theme: operator in query',
    (_name, definition) => {
      expect(queryDescription(definition)).toContain('theme:');
    },
  );

  it.each(DOC_TOOLS.map((d) => [d.name, d] as const))(
    '%s names gdelt_search_themes beside the theme: operator',
    (_name, definition) => {
      expect(queryDescription(definition)).toContain('gdelt_search_themes');
    },
  );

  it('names gdelt_search_themes in the gdelt_search_articles description', () => {
    expect(definitions.gdeltSearchArticles.description).toContain('gdelt_search_themes');
  });

  it('uses only identifiers the GKG theme lookup lists in theme: examples', () => {
    const examples = Object.values(definitions).flatMap((definition) =>
      [...advertisedText(definition).matchAll(/theme:([A-Z][A-Z0-9_-]*)/g)].map((m) => m[1]),
    );
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.filter((id) => !LOOKUP_THEMES.has(id))).toEqual([]);
  });
});
