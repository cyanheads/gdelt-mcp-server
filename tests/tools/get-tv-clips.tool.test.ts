/**
 * @fileoverview Tests for gdelt_get_tv_clips tool.
 * @module tests/tools/get-tv-clips.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    expect(result.query).toBe('vaccine');
    expect(result.clips).toHaveLength(1);
    expect(result.clips[0]?.station).toBe('CNN');
    expect(result.totalReturned).toBe(1);
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

  it('formats output with all required clip fields', () => {
    const output = {
      query: 'vaccine',
      clips: [CLIP],
      totalReturned: 1,
    };
    const blocks = gdeltGetTvClips.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('vaccine');
    expect(text).toContain('Anderson Cooper 360');
    expect(text).toContain('CNN');
    expect(text).toContain(CLIP.date);
    expect(text).toContain(CLIP.snippet);
    expect(text).toContain(CLIP.archiveUrl);
    expect(text).toContain(CLIP.thumbnail);
    expect(text).toContain('1');
  });

  it('handles sparse clip (no thumbnail) in format without error', () => {
    const sparseClip = { ...CLIP };
    delete (sparseClip as { thumbnail?: string }).thumbnail;
    const output = { query: 'test', clips: [sparseClip], totalReturned: 1 };
    const blocks = gdeltGetTvClips.format!(output);
    expect(blocks).toHaveLength(1);
  });
});
