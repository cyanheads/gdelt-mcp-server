/**
 * @fileoverview Tests for gdelt_get_tv_clips tool.
 * @module tests/tools/get-tv-clips.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';

const CLIP = {
  show: 'Anderson Cooper 360',
  station: 'CNN',
  date: '2024-01-15T20:00:00Z',
  snippet: 'The vaccine rollout continues as health officials…',
  archiveUrl: 'https://archive.org/details/CNN_20240115',
  thumbnail: 'https://archive.org/thumb/CNN_20240115.jpg',
};

describe('gdeltGetTvClips', () => {
  beforeEach(() => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvClips: vi.fn().mockResolvedValue([CLIP]),
    } as unknown as tvServiceModule.GdeltTvService);
  });

  it('returns clips for a valid query', async () => {
    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({ query: 'vaccine' });
    const result = await gdeltGetTvClips.handler(input, ctx);
    expect(result.clips).toHaveLength(1);
    expect(result.clips[0]?.station).toBe('CNN');
  });

  it('populates enrichment with query echo and clip count', async () => {
    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({ query: 'vaccine' });
    await gdeltGetTvClips.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('vaccine');
    expect(enrichment.totalCount).toBe(1);
  });

  it('passes stations and maxRecords to the service', async () => {
    const svc = {
      getTvClips: vi.fn().mockResolvedValue([CLIP]),
    } as unknown as tvServiceModule.GdeltTvService;
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(svc);

    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({
      query: 'test',
      stations: ['CNN'],
      maxRecords: 10,
      sort: 'dateDesc',
    });
    await gdeltGetTvClips.handler(input, ctx);
    expect(svc.getTvClips).toHaveBeenCalledWith(
      expect.objectContaining({ stations: ['CNN'], maxRecords: 10, sort: 'dateDesc' }),
      ctx,
    );
  });

  it('throws no_clips when service returns empty array', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvClips: vi.fn().mockResolvedValue([]),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({ query: 'noresults' });
    await expect(gdeltGetTvClips.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_clips' },
    });
  });

  it('includes resolved date range in no_clips error when timespan is provided', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvClips: vi.fn().mockResolvedValue([]),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({ query: 'noresults', timespan: '1y' });
    const err = await gdeltGetTvClips.handler(input, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ data: { reason: 'no_clips' } });
    const hint: string = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;
    expect(hint).toMatch(/Timespan "1y" resolved to \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/);
  });

  it('sets cap-hit notice when returned clips equal maxRecords', async () => {
    // Build an array of maxRecords clips
    const maxRecords = 3;
    const clips = Array.from({ length: maxRecords }, (_, i) => ({
      ...CLIP,
      date: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvClips: vi.fn().mockResolvedValue(clips),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({ query: 'test', maxRecords });
    await gdeltGetTvClips.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/cap reached/);
  });

  it('does not set notice when returned clips are below maxRecords', async () => {
    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({ query: 'vaccine', maxRecords: 10 });
    // mock returns 1 clip, maxRecords is 10
    await gdeltGetTvClips.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('formats output with all required clip fields', () => {
    const output = { clips: [CLIP] };
    const blocks = gdeltGetTvClips.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Anderson Cooper 360');
    expect(text).toContain('CNN');
    expect(text).toContain(CLIP.date);
    expect(text).toContain(CLIP.snippet);
    expect(text).toContain(CLIP.archiveUrl);
    expect(text).toContain(CLIP.thumbnail);
  });

  it('handles sparse clip (no thumbnail) in format without error', () => {
    const sparseClip = { ...CLIP };
    delete (sparseClip as { thumbnail?: string }).thumbnail;
    const output = { clips: [sparseClip] };
    const blocks = gdeltGetTvClips.format!(output);
    expect(blocks).toHaveLength(1);
  });
});
