/**
 * @fileoverview Count cap and disclosure contract tests.
 * @module tests/tools/count-limits.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampToCap,
  countInputSchema,
  limitClampSchema,
  renderLimitClamp,
} from '@/mcp-server/tools/limit-clamp.js';

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (original) => ({
  ...(await original<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: vi.fn(() => ({ add })),
}));

describe('count clamps', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());
  it('accepts large safe integer counts without advertising an upper ceiling', () => {
    const schema = countInputSchema(10, 5, 'Count.');
    expect(schema.parse(1_000_000)).toBe(1_000_000);
    expect(schema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(z.toJSONSchema(schema)).not.toHaveProperty('maximum');
    expect(schema.parse(undefined)).toBe(5);
    for (const value of [0, -1, 1.5, true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
  it('logs once for each actual clamp', () => {
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'info');
    const enrich = vi.spyOn(ctx, 'enrich');
    clampToCap(ctx, 'limit', 1, 10);
    clampToCap(ctx, 'limit', 10, 10);
    expect(log).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    clampToCap(ctx, 'limit', 1_000_000, 10);
    expect(log).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledExactlyOnceWith({
      limitClamp: { parameter: 'limit', requested: 1_000_000, applied: 10 },
    });
    expect(add).toHaveBeenCalledExactlyOnceWith(1, { parameter: 'limit' });
  });
  it('repairs numeric strings through the real contract and renders the clamp on both surfaces', async () => {
    const definition = tool('test_count', {
      description: 'Count contract fixture.',
      input: z.object({ limit: countInputSchema(10, 5, 'Count.') }),
      output: z.object({ applied: z.number().describe('Applied count.') }),
      enrichment: { limitClamp: limitClampSchema },
      enrichmentTrailer: { limitClamp: { render: renderLimitClamp } },
      handler: (input, ctx) => ({ applied: clampToCap(ctx, 'limit', input.limit, 10) }),
      format: (result) => [{ type: 'text' as const, text: `Applied: ${result.applied}` }],
    });
    const result = await runToolContract(definition, { limit: '1000000' } as never);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      applied: 10,
      limitClamp: { parameter: 'limit', requested: 1_000_000, applied: 10 },
    });
    expect(JSON.stringify(result.content)).toContain('limit 1000000 → 10');
    const rejected = await runToolContract(definition, { limit: true } as never);
    expect(rejected.isError).toBe(true);
  });
  it('advertises and enforces the actual cap with clamping disabled', async () => {
    vi.stubEnv('GDELT_CLAMP_LIMITS', 'false');
    vi.resetModules();
    const { countInputSchema: strictCount } = await import('@/mcp-server/tools/limit-clamp.js');
    const schema = strictCount(10, 5, 'Count.');
    expect(z.toJSONSchema(schema)).toHaveProperty('maximum', 10);
    expect(schema.parse(10)).toBe(10);
    expect(schema.safeParse(11).success).toBe(false);
    const handler = vi.fn((input: { limit: number }) => ({ applied: input.limit }));
    const definition = tool('strict_count', {
      description: 'Strict count fixture.',
      input: z.object({ limit: schema }),
      output: z.object({ applied: z.number().describe('Applied count.') }),
      handler,
      format: (result) => [{ type: 'text' as const, text: `Applied: ${result.applied}` }],
    });
    for (const value of [11, '11', true, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await runToolContract(definition, { limit: value } as never);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toHaveProperty('error.code', -32602);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
  it('validates malformed flags explicitly rather than silently enabling clamping', async () => {
    vi.stubEnv('GDELT_CLAMP_LIMITS', 'typo');
    vi.resetModules();
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig).toThrow(/GDELT_CLAMP_LIMITS/);
  });
  it('preserves counts through the cap without enrichment', () => {
    const ctx = createMockContext();
    expect(clampToCap(ctx, 'limit', 10, 10)).toBe(10);
    expect(getEnrichment(ctx)).not.toHaveProperty('limitClamp');
  });
  it('discloses an oversized request with the same rendered values', () => {
    const ctx = createMockContext();
    expect(clampToCap(ctx, 'limit', 11, 10)).toBe(10);
    expect(getEnrichment(ctx).limitClamp).toEqual({
      parameter: 'limit',
      requested: 11,
      applied: 10,
    });
    expect(renderLimitClamp({ parameter: 'limit', requested: 11, applied: 10 })).toBe(
      '**Limit clamped:** limit 11 → 10 (per-call cap)',
    );
  });
});
