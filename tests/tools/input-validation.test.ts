/**
 * @fileoverview Input validation tests for all tool schemas. Verifies that missing,
 * malformed, and out-of-range inputs are rejected by the Zod schemas before handlers run.
 * @module tests/tools/input-validation.test
 */

import { describe, expect, it } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import { gdeltGetToneDistribution } from '@/mcp-server/tools/definitions/get-tone-distribution.tool.js';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import { gdeltGetTvTrending } from '@/mcp-server/tools/definitions/get-tv-trending.tool.js';
import { gdeltListTvStations } from '@/mcp-server/tools/definitions/list-tv-stations.tool.js';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';

describe('gdeltSearchArticles input validation', () => {
  it('rejects an empty query string', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: '' })).toThrow();
  });

  it('rejects maxRecords below 1', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: 'test', maxRecords: 0 })).toThrow();
  });

  it('rejects maxRecords above 250', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: 'test', maxRecords: 251 })).toThrow();
  });

  it('rejects non-integer maxRecords', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: 'test', maxRecords: 1.5 })).toThrow();
  });

  it('rejects an invalid sort value', () => {
    expect(() =>
      gdeltSearchArticles.input.parse({ query: 'test', sort: 'alphabetical' }),
    ).toThrow();
  });

  it('accepts valid query with defaults', () => {
    const parsed = gdeltSearchArticles.input.parse({ query: 'bird flu' });
    expect(parsed.query).toBe('bird flu');
    expect(parsed.maxRecords).toBe(75);
    expect(parsed.sort).toBe('relevance');
  });

  it('accepts all three valid sort values', () => {
    for (const sort of ['date', 'relevance', 'social'] as const) {
      expect(() => gdeltSearchArticles.input.parse({ query: 'test', sort })).not.toThrow();
    }
  });
});

describe('gdeltGetCoverageTimeline input validation', () => {
  it('rejects an empty query string', () => {
    expect(() => gdeltGetCoverageTimeline.input.parse({ query: '', mode: 'volume' })).toThrow();
  });

  it('rejects an invalid mode value', () => {
    expect(() =>
      gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'invalid_mode' }),
    ).toThrow();
  });

  it('rejects smoothing above 5', () => {
    expect(() =>
      gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume', smoothing: 6 }),
    ).toThrow();
  });

  it('rejects smoothing below 0', () => {
    expect(() =>
      gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume', smoothing: -1 }),
    ).toThrow();
  });

  it('rejects non-integer smoothing', () => {
    expect(() =>
      gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume', smoothing: 1.5 }),
    ).toThrow();
  });

  it('accepts all three valid mode values', () => {
    for (const mode of ['volume', 'volume_with_articles', 'tone'] as const) {
      expect(() => gdeltGetCoverageTimeline.input.parse({ query: 'test', mode })).not.toThrow();
    }
  });

  it('accepts smoothing at boundaries 0 and 5', () => {
    for (const smoothing of [0, 5]) {
      expect(() =>
        gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume', smoothing }),
      ).not.toThrow();
    }
  });
});

describe('gdeltGetCoverageBreakdown input validation', () => {
  it('rejects missing query', () => {
    expect(() => gdeltGetCoverageBreakdown.input.parse({ breakdownBy: 'country' })).toThrow();
  });

  it('rejects empty query string', () => {
    expect(() =>
      gdeltGetCoverageBreakdown.input.parse({ query: '', breakdownBy: 'country' }),
    ).toThrow();
  });

  it('rejects missing breakdownBy', () => {
    expect(() => gdeltGetCoverageBreakdown.input.parse({ query: 'test' })).toThrow();
  });

  it('rejects invalid breakdownBy value', () => {
    expect(() =>
      gdeltGetCoverageBreakdown.input.parse({ query: 'test', breakdownBy: 'topic' }),
    ).toThrow();
  });

  it('accepts both valid breakdownBy values', () => {
    for (const breakdownBy of ['language', 'country'] as const) {
      expect(() =>
        gdeltGetCoverageBreakdown.input.parse({ query: 'test', breakdownBy }),
      ).not.toThrow();
    }
  });
});

describe('gdeltGetToneDistribution input validation', () => {
  it('rejects empty query', () => {
    expect(() => gdeltGetToneDistribution.input.parse({ query: '' })).toThrow();
  });

  it('accepts a minimal valid input', () => {
    expect(() => gdeltGetToneDistribution.input.parse({ query: 'test' })).not.toThrow();
  });
});

describe('gdeltGetTvClips input validation', () => {
  it('rejects empty query', () => {
    expect(() => gdeltGetTvClips.input.parse({ query: '' })).toThrow();
  });

  it('rejects maxRecords below 1', () => {
    expect(() => gdeltGetTvClips.input.parse({ query: 'test', maxRecords: 0 })).toThrow();
  });

  it('rejects invalid sort value', () => {
    expect(() => gdeltGetTvClips.input.parse({ query: 'test', sort: 'newest' })).toThrow();
  });

  it('accepts all three valid sort values', () => {
    for (const sort of ['relevance', 'dateDesc', 'dateAsc'] as const) {
      expect(() => gdeltGetTvClips.input.parse({ query: 'test', sort })).not.toThrow();
    }
  });
});

describe('gdeltGetTvContext input validation', () => {
  it('rejects empty query', () => {
    expect(() => gdeltGetTvContext.input.parse({ query: '' })).toThrow();
  });

  it('accepts a valid query', () => {
    expect(() => gdeltGetTvContext.input.parse({ query: 'pandemic' })).not.toThrow();
  });
});

describe('gdeltGetTvTrending input validation', () => {
  it('accepts an empty input object', () => {
    expect(() => gdeltGetTvTrending.input.parse({})).not.toThrow();
  });
});

describe('gdeltListTvStations input validation', () => {
  it('accepts an empty input object', () => {
    expect(() => gdeltListTvStations.input.parse({})).not.toThrow();
  });
});

describe('gdeltSearchTv input validation', () => {
  it('rejects empty query', () => {
    expect(() => gdeltSearchTv.input.parse({ query: '' })).toThrow();
  });

  it('rejects non-integer smoothing', () => {
    expect(() => gdeltSearchTv.input.parse({ query: 'test', smoothing: 1.7 })).toThrow();
  });

  it('accepts valid query with optional fields', () => {
    const parsed = gdeltSearchTv.input.parse({ query: 'vaccine', stations: ['CNN'] });
    expect(parsed.query).toBe('vaccine');
    expect(parsed.stations).toEqual(['CNN']);
  });
});
