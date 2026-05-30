/**
 * @fileoverview Security tests across all tools. Covers injection attempts, oversized
 * inputs, and assertions that no secret, API key, or env value ever appears in
 * tool output or error messages.
 * @module tests/tools/security.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ARTICLE = {
  url: 'https://example.com/article',
  title: 'Test Article',
  seendate: '20240101T120000Z',
  domain: 'example.com',
  language: 'English',
  sourcecountry: 'United States',
};

const TIMELINE_SERIES = [
  { label: 'Volume Intensity', data: [{ date: '2024-01-01T00:00:00Z', value: 1.0 }] },
];

const CLIP = {
  show: 'Test Show',
  station: 'CNN',
  date: '2024-01-01T00:00:00Z',
  snippet: 'test snippet',
  archiveUrl: 'https://archive.org/details/TEST',
};

const TV_RESULT = {
  series: [{ station: 'CNN', data: [{ date: '2024-01-01', value: 0.5 }] }],
  dateResolution: 'day' as const,
  timeRange: { start: '2024-01-01', end: '2024-01-01' },
  normalized: true,
};

beforeEach(() => {
  vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
    searchArticles: vi.fn().mockResolvedValue({ articles: [ARTICLE], totalReturned: 1 }),
    getTimeline: vi.fn().mockResolvedValue(TIMELINE_SERIES),
    getToneDistribution: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
  } as unknown as docServiceModule.GdeltDocService);

  vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
    getTvClips: vi.fn().mockResolvedValue([CLIP]),
    searchTv: vi.fn().mockResolvedValue(TV_RESULT),
    getTvContext: vi.fn().mockResolvedValue({ words: [], clipsAnalyzed: 0 }),
    getTvTrending: vi.fn().mockResolvedValue([]),
    listStations: vi.fn().mockResolvedValue([]),
  } as unknown as tvServiceModule.GdeltTvService);
});

// ─── Injection: malicious query strings pass through without code execution ──

describe('injection handling', () => {
  it('search-articles accepts a query containing SQL-like injection without throwing', async () => {
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({
      query: "'; DROP TABLE articles; --",
    });
    // Handler should not throw — query is passed as a string to the (mocked) service
    await expect(gdeltSearchArticles.handler(input, ctx)).resolves.toBeDefined();
  });

  it('search-articles accepts a query containing script-tag injection without throwing', async () => {
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({
      query: '<script>alert(1)</script>',
    });
    await expect(gdeltSearchArticles.handler(input, ctx)).resolves.toBeDefined();
  });

  it('search-articles accepts a query containing path traversal without throwing', async () => {
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({
      query: '../../../etc/passwd',
    });
    await expect(gdeltSearchArticles.handler(input, ctx)).resolves.toBeDefined();
  });

  it('coverage timeline accepts GDELT operator injection attempt in query', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({
      query: 'test&format=csv&mode=artlist',
      mode: 'volume',
    });
    await expect(gdeltGetCoverageTimeline.handler(input, ctx)).resolves.toBeDefined();
  });

  it('get-tv-clips accepts query with null byte injection attempt', async () => {
    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({ query: 'test\x00payload' });
    await expect(gdeltGetTvClips.handler(input, ctx)).resolves.toBeDefined();
  });
});

// ─── Oversized inputs ─────────────────────────────────────────────────────────

describe('oversized inputs', () => {
  it('search-articles: very long query string is accepted by the schema', () => {
    const longQuery = 'a'.repeat(10_000);
    // Zod does not set a max length on the query — it passes through
    expect(() => gdeltSearchArticles.input.parse({ query: longQuery })).not.toThrow();
  });

  it('search-tv: array with many stations is accepted by the schema', () => {
    const manyStations = Array.from({ length: 200 }, (_, i) => `STATION${i}`);
    expect(() =>
      gdeltSearchTv.input.parse({ query: 'test', stations: manyStations }),
    ).not.toThrow();
  });

  it('get-tv-clips maxRecords at maximum boundary 3000 is accepted', () => {
    expect(() => gdeltGetTvClips.input.parse({ query: 'test', maxRecords: 3000 })).not.toThrow();
  });

  it('get-tv-clips maxRecords above maximum 3001 is rejected', () => {
    expect(() => gdeltGetTvClips.input.parse({ query: 'test', maxRecords: 3001 })).toThrow();
  });
});

// ─── No secrets in output ─────────────────────────────────────────────────────

describe('no secrets in output', () => {
  const ENV_VARS_THAT_COULD_LEAK = [
    'HOME',
    'USER',
    'PATH',
    'SHELL',
    'GDELT_BASE_URL',
    'MCP_AUTH_SECRET_KEY',
    'GDELT_API_KEY',
  ];

  it('search-articles format output does not contain env variable values', () => {
    const output = { articles: [ARTICLE] };
    const blocks = gdeltSearchArticles.format!(output);
    const text = JSON.stringify(blocks);
    for (const key of ENV_VARS_THAT_COULD_LEAK) {
      const val = process.env[key];
      if (val && val.length > 4) {
        // Only check meaningful values to avoid false positives on empty/trivial strings
        expect(text).not.toContain(val);
      }
    }
  });

  it('search-articles error message does not expose internal paths', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      searchArticles: vi.fn().mockResolvedValue({ articles: [], totalReturned: 0 }),
    } as unknown as docServiceModule.GdeltDocService);
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'noresults' });
    let thrown: unknown;
    try {
      await gdeltSearchArticles.handler(input, ctx);
    } catch (e) {
      thrown = e;
    }
    const msg = String(thrown instanceof Error ? thrown.message : JSON.stringify(thrown));
    // The error message should not contain filesystem paths or env values
    expect(msg).not.toMatch(/\/Users\//);
    expect(msg).not.toMatch(/process\.env/);
  });

  it('get-coverage-timeline format output does not contain env variable values', () => {
    const output = {
      dateResolution: 'hour' as const,
      series: TIMELINE_SERIES,
    };
    const blocks = gdeltGetCoverageTimeline.format!(output);
    const text = JSON.stringify(blocks);
    for (const key of ENV_VARS_THAT_COULD_LEAK) {
      const val = process.env[key];
      if (val && val.length > 4) {
        expect(text).not.toContain(val);
      }
    }
  });

  it('tv clips format output does not contain env variable values', () => {
    const output = { clips: [CLIP] };
    const blocks = gdeltGetTvClips.format!(output);
    const text = JSON.stringify(blocks);
    for (const key of ENV_VARS_THAT_COULD_LEAK) {
      const val = process.env[key];
      if (val && val.length > 4) {
        expect(text).not.toContain(val);
      }
    }
  });
});

// ─── SSRF: URL-like query values do not cause open redirects ─────────────────

describe('SSRF via URL-like query values', () => {
  it('search-articles passes a URL-like query string safely through to the (mocked) service', async () => {
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({
      query: 'http://internal-host:9200/_cat/indices',
    });
    // The URL is treated as a search string — no real HTTP request is made (service is mocked)
    await expect(gdeltSearchArticles.handler(input, ctx)).resolves.toBeDefined();
  });

  it('search-tv passes a URL-like query string safely through to the (mocked) service', async () => {
    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({
      query: 'https://169.254.169.254/latest/meta-data',
    });
    await expect(gdeltSearchTv.handler(input, ctx)).resolves.toBeDefined();
  });
});

// ─── Unicode/encoding edge cases ─────────────────────────────────────────────

describe('unicode and encoding edge cases', () => {
  it('search-articles accepts a query with unicode characters', async () => {
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: '新冠病毒 OR 流感' });
    await expect(gdeltSearchArticles.handler(input, ctx)).resolves.toBeDefined();
  });

  it('search-articles format handles a title with special HTML entities', () => {
    const articleWithEntities = {
      ...ARTICLE,
      title: '<b>Breaking & "News"</b> — It\'s Critical',
    };
    const output = { articles: [articleWithEntities] };
    // Should not throw
    expect(() => gdeltSearchArticles.format!(output)).not.toThrow();
    const blocks = gdeltSearchArticles.format!(output);
    expect(blocks).toHaveLength(1);
  });

  it('search-articles format handles article with empty title', () => {
    const output = { articles: [{ ...ARTICLE, title: '' }] };
    expect(() => gdeltSearchArticles.format!(output)).not.toThrow();
  });
});
