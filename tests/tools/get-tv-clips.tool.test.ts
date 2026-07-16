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

  /**
   * Cap-hit overflow at the schema ceiling. The notice used to say "Increase maxRecords up to
   * 3000" unconditionally — including at maxRecords: 3000, where it instructed the caller to
   * raise the value already in use. GDELT has no cursor, so the only real route past 3000 is a
   * narrower date window; these cases pin that the ceiling branch says so and hands back the
   * exact windows to use.
   */
  describe('overflow at the 3000 ceiling', () => {
    const CEILING = 3000;

    async function runAtCeiling(extra: Record<string, unknown>) {
      const clips = Array.from({ length: CEILING }, (_, i) => ({
        ...CLIP,
        archiveUrl: `https://archive.org/details/CNN_${i}`,
      }));
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: vi.fn().mockResolvedValue(clips),
      } as unknown as tvServiceModule.GdeltTvService);

      const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
      const input = gdeltGetTvClips.input.parse({
        query: 'vaccine',
        stations: ['CNN'],
        maxRecords: CEILING,
        ...extra,
      });
      await gdeltGetTvClips.handler(input, ctx);
      return getEnrichment(ctx);
    }

    it('never tells the caller to raise maxRecords once it is already at 3000', async () => {
      const enrichment = await runAtCeiling({
        startDatetime: '20200101000000',
        endDatetime: '20200201000000',
      });
      expect(enrichment.notice).not.toMatch(/[Ii]ncrease maxRecords/);
      expect(enrichment.notice).toMatch(/ceiling/);
    });

    it('hands back the window halved, overlapping by a second so nothing falls through', async () => {
      const enrichment = await runAtCeiling({
        startDatetime: '20200101000000',
        endDatetime: '20200103000000',
      });
      expect(enrichment.continuationWindows).toEqual([
        { startDatetime: '20200101000000', endDatetime: '20200102000000' },
        { startDatetime: '20200101235959', endDatetime: '20200103000000' },
      ]);
      expect(enrichment.notice).toMatch(/de-duplicate/);
    });

    it('says how to pin a window when the call never set one, and emits no windows', async () => {
      const enrichment = await runAtCeiling({});
      expect(enrichment.continuationWindows).toBeUndefined();
      expect(enrichment.notice).toMatch(/startDatetime\/endDatetime/);
    });

    it('still recommends raising maxRecords below the ceiling', async () => {
      const clips = Array.from({ length: 50 }, (_, i) => ({
        ...CLIP,
        archiveUrl: `https://archive.org/details/CNN_${i}`,
      }));
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: vi.fn().mockResolvedValue(clips),
      } as unknown as tvServiceModule.GdeltTvService);

      const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
      const input = gdeltGetTvClips.input.parse({ query: 'vaccine', maxRecords: 50 });
      await gdeltGetTvClips.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toMatch(/Increase maxRecords up to 3000/);
      expect(enrichment.continuationWindows).toBeUndefined();
    });
  });
});
