/**
 * @fileoverview Tests for gdelt_get_tv_clips tool.
 * @module tests/tools/get-tv-clips.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import { parseGdeltJson } from '@/services/gdelt/gdelt-fetch.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';
import { contentText, hrefFor, literalHtml, renderMarkdown } from './markdown-render.js';

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

  describe('zero-match answer', () => {
    beforeEach(() => {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: vi.fn().mockResolvedValue([]),
      } as unknown as tvServiceModule.GdeltTvService);
    });

    it('returns an empty clip list with echoes and the archive-window guidance', async () => {
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'zqxwvjkplmq',
        stations: ['CNN'],
        startDatetime: '20240901000000',
        endDatetime: '20241001000000',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        clips: [],
        effectiveQuery: 'zqxwvjkplmq',
        totalCount: 0,
        notice: expect.stringMatching(/No TV clips matched "zqxwvjkplmq".*October 2024/),
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('No clips returned.');
      expect(text.match(/^> /gm)).toHaveLength(1);
      // The caller already pinned a window: the guidance checks it rather than asking for one.
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).not.toMatch(/supply explicit/);
      expect(notice).toMatch(/check that 20240901000000–20241001000000 falls inside it/);
    });

    it('names the resolved date range when a timespan was used', async () => {
      const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
      const input = gdeltGetTvClips.input.parse({ query: 'noresults', timespan: '1y' });
      const result = await gdeltGetTvClips.handler(input, ctx);
      expect(result.clips).toEqual([]);
      expect(getEnrichment(ctx).notice).toMatch(
        /Timespan "1y" resolved to \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/,
      );
      expect(getEnrichment(ctx).notice).toMatch(/supply explicit startDatetime\/endDatetime/);
    });

    it('no longer declares a no_clips contract entry', () => {
      expect(gdeltGetTvClips.errors?.map((e) => e.reason)).not.toContain('no_clips');
    });

    it('describes the empty case on the notice field', () => {
      expect(gdeltGetTvClips.enrichment?.notice?.description).toMatch(/no clips matched/i);
    });
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

    /** 3,000 clips aired inside every window these cases request, so none is dropped. */
    async function runAtCeiling(extra: Record<string, unknown>, date = '2020-01-01T12:00:00Z') {
      const clips = Array.from({ length: CEILING }, (_, i) => ({
        ...CLIP,
        date,
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
      expect(enrichment.notice).not.toMatch(/[Ii]ncrease maxRecords|[Rr]aise maxRecords/);
      expect(enrichment.notice).toMatch(/ceiling/);
    });

    /**
     * A full 3,000 never fits the byte budget, so the uncut ceiling branch is reached only when
     * GDELT fills maxRecords mostly with clips from outside the window, which are dropped.
     */
    it('hands back halves on an uncut page when the cap was filled with out-of-window clips', async () => {
      const enrichment = await runAtCeiling(
        { startDatetime: '20200101000000', endDatetime: '20200103000000' },
        '2020-01-05T00:00:00Z',
      );
      expect(enrichment.totalCount).toBe(0);
      expect(enrichment.withheldCount).toBeUndefined();
      expect(enrichment.continuationWindows).toHaveLength(2);
      expect(enrichment.notice).toMatch(
        /GDELT returned 3000 clips — maxRecords is already at its 3000 ceiling/,
      );
      expect(enrichment.notice).toMatch(
        /returned 3000 clips aired outside 20200101000000–20200103000000/,
      );
    });

    /**
     * GDELT TV answers whole clock hours, so halves that met at a second inside an hour would
     * both fetch that hour and hit the same cap. The split falls on the hour nearest the middle,
     * and the halves share no second: the drop keeps each to its own seconds exactly.
     */
    it('splits the window on the hour nearest its middle, the halves sharing no second', async () => {
      const enrichment = await runAtCeiling({
        startDatetime: '20200101000000',
        endDatetime: '20200103000000',
      });
      expect(enrichment.continuationWindows).toEqual([
        { startDatetime: '20200101000000', endDatetime: '20200101235959' },
        { startDatetime: '20200102000000', endDatetime: '20200103000000' },
      ]);
      expect(enrichment.notice).toMatch(/whole clock hours/);
    });

    /**
     * The 3,000 clips at 01:30 are cut to the budget: those withheld were fetched and sit inside
     * the window, so a sub-hour half reaches them — only clips past the cap of that hour can't be.
     */
    it('splits a cut window inside one clock hour at the second, even at the ceiling', async () => {
      const enrichment = await runAtCeiling(
        { startDatetime: '20200101010500', endDatetime: '20200101015000' },
        '2020-01-01T01:30:00Z',
      );
      expect(enrichment.continuationWindows).toEqual([
        { startDatetime: '20200101010500', endDatetime: '20200101012730' },
        { startDatetime: '20200101012731', endDatetime: '20200101015000' },
      ]);
      expect(enrichment.notice).toMatch(
        /more clips matched upstream than any window inside this hour can fetch/,
      );
    });

    it('offers no halves when an uncut page at the ceiling has no clock hour inside its window', async () => {
      const enrichment = await runAtCeiling(
        { startDatetime: '20200101010500', endDatetime: '20200101015000' },
        '2020-01-01T01:55:00Z',
      );
      expect(enrichment.withheldCount).toBeUndefined();
      expect(enrichment.continuationWindows).toBeUndefined();
      expect(enrichment.notice).toMatch(/not retrievable/);
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
      expect(enrichment.notice).toMatch(/Raise maxRecords \(up to 3000\)/);
      expect(enrichment.notice).toMatch(/48,000-byte/);
      expect(enrichment.continuationWindows).toBeUndefined();
    });
  });

  /**
   * Upstream text reaches content[] as literal text: every upstream value in format() goes
   * through the shared escaper, while structuredContent keeps the raw value.
   */
  describe('Markdown escaping at the content[] boundary', () => {
    const HOSTILE = {
      show: '*Breaking* [Live]',
      station: 'CNN #',
      date: '2024-01-15T20:00:00Z',
      snippet: 'line one\n- line two [x](y) <i>tag</i> &copy;',
      archiveUrl: 'https://archive.org/details/CNN_X#start/1/end/36',
      thumbnail: 'https://archive.org/thumb/CNN_(X).jpg',
    };

    it('renders plain upstream values byte-identically to the pre-escaping format()', () => {
      const blocks = gdeltGetTvClips.format!({ clips: [CLIP] });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT TV Clips\n\n### Anderson Cooper 360 — CNN\n**Date:** 2024-01-15T20:00:00Z\n' +
          '**Snippet:** The vaccine rollout continues as health officials…\n' +
          '**View clip:** https://archive.org/details/CNN_20240115\n' +
          '**Thumbnail:** https://archive.org/thumb/CNN_20240115.jpg',
      );
    });

    it('escapes markup in every upstream field of content[] and leaves structuredContent raw', async () => {
      mockClips([HOSTILE]);
      const result = await runToolContract(gdeltGetTvClips, { query: 'x', stations: ['CNN'] });
      expect((result.structuredContent as { clips: unknown[] }).clips).toEqual([HOSTILE]);
      expect((result.content[0] as { text: string }).text).toBe(
        [
          '## GDELT TV Clips',
          '',
          String.raw`### \*Breaking\* \[Live\] — CNN \#`,
          '**Date:** 2024-01-15T20:00:00Z',
          String.raw`**Snippet:** line one - line two \[x\](y) \<i>tag\</i> \&copy;`,
          '**View clip:** https://archive.org/details/CNN_X#start/1/end/36',
          '**Thumbnail:** <https://archive.org/thumb/CNN_(X).jpg>',
        ].join('\n'),
      );
    });

    it.each([true, false])(
      'keeps a snippet line break from opening a list, under a CommonMark parser (GFM autolinks: %s)',
      async (gfmAutolinks) => {
        mockClips([HOSTILE]);
        const result = await runToolContract(gdeltGetTvClips, { query: 'x', stations: ['CNN'] });
        const html = renderMarkdown(contentText(result), { gfmAutolinks });
        expect(html).toContain(`<h3>${literalHtml('*Breaking* [Live] — CNN #')}</h3>`);
        expect(html).toContain(
          `<strong>Snippet:</strong> ${literalHtml('line one - line two [x](y) <i>tag</i> &copy;')}`,
        );
        expect(html).toContain(
          `<a href="${hrefFor(HOSTILE.thumbnail)}">${literalHtml(HOSTILE.thumbnail)}</a>`,
        );
        expect(html).not.toMatch(/<(ul|li|i|em)>|<a href="y"/);
      },
    );
  });

  describe('48,000-byte response budget', () => {
    const WINDOW = { startDatetime: '20240701000000', endDatetime: '20240702000000' };

    it('keeps a full 3,000-clip page of long multi-byte records within 50,000 bytes on each surface', async () => {
      const fetched = Array.from({ length: 3000 }, (_, i) => longClip(i, secondsAfter(NOON, -i)));
      mockClips(fetched);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'climate',
        stations: ['CNN'],
        maxRecords: 3000,
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ClipPage;
      const emitted = sc.clips.length;
      expect(utf8(JSON.stringify(sc))).toBeLessThanOrEqual(50_000);
      expect(utf8(contentText(result))).toBeLessThanOrEqual(50_000);
      expect(emitted).toBeGreaterThan(0);
      expect(sc.clips).toEqual(fetched.slice(0, emitted));
      expect(sc.totalCount).toBe(emitted);
      expect(sc.withheldCount).toBe(3000 - emitted);
      const charges = fetched.map(chargeOf);
      expect(sum(charges.slice(0, emitted))).toBeLessThanOrEqual(BUDGET);
      expect(sum(charges.slice(0, emitted + 1))).toBeGreaterThan(BUDGET);
      // Both surfaces carry the same clips: content[] is exactly format() of the emitted set.
      expect((result.content[0] as { text: string }).text).toBe(
        (gdeltGetTvClips.format!({ clips: sc.clips })[0] as { text: string }).text,
      );
      expect(sc.notice).toMatch(new RegExp(`Emitted ${emitted} of 3000 clips`));
      expect(sc.notice).not.toMatch(/[Rr]aise maxRecords|[Ii]ncrease maxRecords/);
    });

    it('leaves a page that fits unchanged: no size notice, no withheldCount, no continuation', async () => {
      const fetched = Array.from({ length: 49 }, (_, i) => ({
        ...CLIP,
        archiveUrl: `https://archive.org/details/CNN_${i}`,
      }));
      mockClips(fetched);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'vaccine',
        stations: ['CNN'],
      });
      expect(result.structuredContent).toEqual({
        clips: fetched,
        effectiveQuery: 'vaccine',
        totalCount: 49,
      });
    });

    it('emits every clip of a page whose charges total exactly 48,000 bytes', async () => {
      const fetched = exactFitClips(100, 480);
      mockClips(fetched);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 3000,
        ...WINDOW,
      });
      expect(sum(fetched.map(chargeOf))).toBe(BUDGET);
      const sc = result.structuredContent as ClipPage;
      expect(sc.clips).toHaveLength(100);
      expect(sc).not.toHaveProperty('withheldCount');
      expect(sc).not.toHaveProperty('notice');
    });

    it('withholds the clip that takes the page one byte over the budget', async () => {
      const fetched = exactFitClips(100, 480);
      const last = fetched[99]!;
      fetched[99] = { ...last, snippet: `${last.snippet}!` };
      mockClips(fetched);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 3000,
        ...WINDOW,
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.clips).toHaveLength(99);
      expect(sc.withheldCount).toBe(1);
    });

    it('emits a clip larger than the whole budget alone, with the cut signal', async () => {
      const giant = { ...longClip(0, NOON), snippet: 'a'.repeat(60_000) };
      const fetched = [
        giant,
        longClip(1, secondsAfter(NOON, -1)),
        longClip(2, secondsAfter(NOON, -2)),
      ];
      mockClips(fetched);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.clips).toEqual([giant]);
      expect(sc.withheldCount).toBe(2);
      expect(sc.notice).toMatch(/Emitted 1 of 3 clips/);
      // A window resumed at NOON would return the giant first again, so the continuation skips
      // past its second: the withheld clips at NOON−1 s and NOON−2 s are reachable there.
      expect(sc.continuationWindows).toEqual([
        { startDatetime: WINDOW.startDatetime, endDatetime: '20240701115959' },
      ]);
      expect(sc.notice).toMatch(/clips from that second not emitted here cannot be reached/);
      expect(sc.notice).toMatch(/every earlier clip/);
    });

    it.each([
      ['dateDesc', -1],
      ['dateAsc', 1],
    ] as const)('resumes a %s cut from the last emitted clip', async (sort, step) => {
      const anchor = sort === 'dateDesc' ? secondsAfter(DAY, 3600) : secondsAfter(DAY, -3600);
      const fetched = Array.from({ length: 400 }, (_, i) =>
        longClip(i, secondsAfter(anchor, step * i * 30)),
      );
      mockClips(fetched);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 3000,
        sort,
        startDatetime: '20240630000000',
        endDatetime: '20240702000000',
      });
      const sc = result.structuredContent as ClipPage;
      const lastMs = Date.parse(sc.clips.at(-1)!.date);
      expect(sc.continuationWindows).toEqual([
        sort === 'dateDesc'
          ? { startDatetime: '20240630000000', endDatetime: gdeltAt(lastMs + 1000) }
          : { startDatetime: gdeltAt(lastMs - 1000), endDatetime: '20240702000000' },
      ]);
      expect(sc.notice).toMatch(/de-duplicate by archiveUrl/);
      expect(sc.notice).not.toMatch(/[Rr]aise maxRecords|[Ii]ncrease maxRecords/);
    });

    it('hands back the #21 halves for a relevance cut, naming N of M and the sort', async () => {
      mockClips(Array.from({ length: 400 }, (_, i) => longClip(i, secondsAfter(DAY, i))));
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 3000,
        sort: 'relevance',
        startDatetime: '20240701000000',
        endDatetime: '20240703000000',
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.continuationWindows).toEqual([
        { startDatetime: '20240701000000', endDatetime: '20240701235959' },
        { startDatetime: '20240702000000', endDatetime: '20240703000000' },
      ]);
      expect(sc.notice).toMatch(new RegExp(`Emitted ${sc.clips.length} of 400 clips`));
      expect(sc.notice).toMatch(/[Ss]ort relevance has no resume point/);
      expect(sc.notice).not.toMatch(/[Rr]aise maxRecords|[Ii]ncrease maxRecords/);
    });

    /**
     * Every clip GDELT returned shares NOON and the cap was not reached, so nothing earlier
     * exists in the window: the window past that second would be empty.
     */
    it('offers no window when every fetched clip shares the last emitted second', async () => {
      const at = NOON;
      mockClips(Array.from({ length: 200 }, (_, i) => longClip(i, at)));
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 3000,
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.withheldCount).toBeGreaterThan(0);
      expect(sc).not.toHaveProperty('continuationWindows');
      expect(sc.notice).toMatch(/cannot be reached by narrowing the date window/);
    });

    it('skips past a shared last second to the earlier withheld clips, and reaches them', async () => {
      const shared = Array.from({ length: 80 }, (_, i) => longClip(i, NOON));
      const earlier = Array.from({ length: 30 }, (_, i) =>
        longClip(100 + i, secondsAfter(NOON, -60 * (i + 1))),
      );
      const upstream = measuredTvUpstream([...shared, ...earlier]);
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: upstream,
      } as unknown as tvServiceModule.GdeltTvService);
      const base = { query: 'x', stations: ['CNN'], maxRecords: 3000, sort: 'dateDesc' as const };
      const first = await runToolContract(gdeltGetTvClips, { ...base, ...WINDOW });
      const sc = first.structuredContent as ClipPage;
      expect(sc.clips.every((c) => c.date === NOON)).toBe(true);
      expect(sc.continuationWindows).toEqual([
        { startDatetime: WINDOW.startDatetime, endDatetime: '20240701115959' },
      ]);
      const next = await runToolContract(
        gdeltGetTvClips,
        gdeltGetTvClips.input.parse({ ...base, ...sc.continuationWindows![0] }),
      );
      const followUp = (next.structuredContent as ClipPage).clips;
      expect(followUp.map((c) => c.archiveUrl).sort()).toEqual(
        earlier.map((c) => c.archiveUrl).sort(),
      );
    });

    it('gives the resume timestamp to pair with the other boundary when no window is known', async () => {
      const fetched = Array.from({ length: 200 }, (_, i) => longClip(i, secondsAfter(DAY, -i)));
      mockClips(fetched);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 3000,
        sort: 'dateDesc',
      });
      const sc = result.structuredContent as ClipPage;
      const lastMs = Date.parse(sc.clips.at(-1)!.date);
      expect(sc).not.toHaveProperty('continuationWindows');
      expect(sc.notice).toContain(`endDatetime ${gdeltAt(lastMs + 1000)}`);
      expect(sc.notice).toMatch(/paired with a startDatetime/);
    });

    /**
     * A bigger maxRecords is never offered as the way to fit more into this response — the
     * budget cut the page. Below the ceiling, though, the continuation should run at 3000: each
     * continuation request fetches whole clock hours, and clips from outside its window would
     * otherwise use up a small maxRecords first.
     */
    it('continues a page cut below the ceiling at maxRecords 3000, never raising it to fit this response', async () => {
      mockClips(Array.from({ length: 200 }, (_, i) => longClip(i, secondsAfter(NOON, -i))));
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 200,
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.withheldCount).toBeGreaterThan(0);
      expect(sc.notice).toMatch(/cap was reached too/);
      expect(sc.notice).toMatch(
        /Continue with maxRecords 3000: each continuation request fetches whole clock hours/,
      );
      expect(sc.notice).not.toMatch(/[Rr]aise maxRecords|[Ii]ncrease maxRecords/);
    });

    it('adds no maxRecords advice to a cut page already at the ceiling', async () => {
      mockClips(Array.from({ length: 200 }, (_, i) => longClip(i, secondsAfter(NOON, -i))));
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 3000,
        sort: 'dateDesc',
        ...WINDOW,
      });
      expect((result.structuredContent as ClipPage).notice).not.toMatch(/Continue with maxRecords/);
    });

    /**
     * Follow the continuation to the end against the measured TV API: each resume window goes
     * back through the input schema, GDELT answers whole clock hours around it, and it rejects
     * a window under 30 minutes. The dense walk's resume windows shrink toward the fixed
     * boundary until they are minutes wide — every request must still be accepted, and every
     * call must emit clips no earlier call did until the window is exhausted.
     */
    it.each([
      [
        'dateDesc',
        'sparse',
        600,
        60,
        { startDatetime: '20240630000000', endDatetime: '20240702000000' },
      ],
      [
        'dateAsc',
        'sparse',
        600,
        60,
        { startDatetime: '20240630000000', endDatetime: '20240702000000' },
      ],
      [
        'dateDesc',
        'dense',
        720,
        10,
        { startDatetime: '20240701000000', endDatetime: '20240701020000' },
      ],
      [
        'dateAsc',
        'dense',
        720,
        10,
        { startDatetime: '20240701000000', endDatetime: '20240701020000' },
      ],
    ] as const)(
      'walks a %s continuation over a %s window to completion against the measured TV API',
      async (sort, _density, count, spacing, window) => {
        const all = Array.from({ length: count }, (_, i) =>
          longClip(i, secondsAfter(DAY, spacing * i + 5)),
        );
        const upstream = measuredTvUpstream(all);
        vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
          getTvClips: upstream,
        } as unknown as tvServiceModule.GdeltTvService);

        let input = gdeltGetTvClips.input.parse({
          query: 'x',
          stations: ['CNN'],
          maxRecords: 3000,
          sort,
          ...window,
        });
        const seen = new Set<string>();
        let calls = 0;
        let narrowest = Number.POSITIVE_INFINITY;
        for (;;) {
          narrowest = Math.min(narrowest, spanSeconds(input));
          const result = await runToolContract(gdeltGetTvClips, input);
          calls++;
          expect(result.isError).toBeFalsy();
          const sc = result.structuredContent as ClipPage;
          const before = seen.size;
          for (const c of sc.clips) seen.add(c.archiveUrl);
          expect(seen.size).toBeGreaterThan(before);
          if (!sc.continuationWindows) {
            expect(sc).not.toHaveProperty('withheldCount');
            break;
          }
          expect(sc.continuationWindows).toHaveLength(1);
          input = gdeltGetTvClips.input.parse({ ...input, ...sc.continuationWindows[0] });
          expect(calls).toBeLessThan(100);
        }
        expect(calls).toBeGreaterThan(2);
        expect([...seen].sort()).toEqual(all.map((c) => c.archiveUrl).sort());
        if (_density === 'dense') expect(narrowest).toBeLessThan(30 * 60);
      },
    );

    /**
     * At a low maxRecords a resumed dateAsc request, floored to the hour, spends its slots on the
     * minutes already walked before any new clip. The cut page says to resume at maxRecords 3000;
     * a caller that follows the notice makes progress on every hop.
     */
    it('walks a dateAsc continuation at a low maxRecords by following the notice', async () => {
      const all = Array.from({ length: 720 }, (_, i) => longClip(i, secondsAfter(DAY, 10 * i + 5)));
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: measuredTvUpstream(all),
      } as unknown as tvServiceModule.GdeltTvService);

      let input = gdeltGetTvClips.input.parse({
        query: 'x',
        stations: ['CNN'],
        maxRecords: 90,
        sort: 'dateAsc',
        startDatetime: '20240701000000',
        endDatetime: '20240701020000',
      });
      const seen = new Set<string>();
      let calls = 0;
      for (;;) {
        const result = await runToolContract(gdeltGetTvClips, input);
        calls++;
        const sc = result.structuredContent as ClipPage;
        const before = seen.size;
        for (const c of sc.clips) seen.add(c.archiveUrl);
        expect(seen.size).toBeGreaterThan(before);
        if (!sc.continuationWindows) break;
        const maxRecords = /maxRecords 3000/.test(sc.notice ?? '') ? 3000 : input.maxRecords;
        input = gdeltGetTvClips.input.parse({ ...input, ...sc.continuationWindows[0], maxRecords });
        expect(calls).toBeLessThan(100);
      }
      expect([...seen].sort()).toEqual(all.map((c) => c.archiveUrl).sort());
    });

    it('says how many maxRecords slots out-of-window clips took when the cap was hit', async () => {
      const outside = Array.from({ length: 70 }, (_, i) => CLIP_AT(secondsAfter(DAY, i), i));
      const inside = Array.from({ length: 20 }, (_, i) =>
        CLIP_AT(secondsAfter(DAY, 1800 + i), 100 + i),
      );
      mockClips([...outside, ...inside]);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 90,
        sort: 'dateAsc',
        startDatetime: '20240701003000',
        endDatetime: '20240701020000',
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.clips).toHaveLength(20);
      expect(sc.notice).toMatch(/took 70 of the 90 maxRecords slots/);
      expect(sc.notice).not.toMatch(/not a sign of missing results/);
      expect(maxRecordsDirectives(sc.notice)).toEqual(['Raise maxRecords']);
    });

    /**
     * A cut page that also dropped out-of-window clips after the cap was hit has two reasons to
     * mention maxRecords — the slots the dropped clips took and the headroom continuation needs —
     * and one directive covers both.
     */
    it('gives one maxRecords directive on a cut, capped page that also dropped clips', async () => {
      const all = Array.from({ length: 150 }, (_, i) =>
        longClip(i, secondsAfter('2024-01-16T01:00:05Z', i * 10)),
      );
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: measuredTvUpstream(all),
      } as unknown as tvServiceModule.GdeltTvService);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 100,
        sort: 'dateAsc',
        startDatetime: '20240116010500',
        endDatetime: '20240116015959',
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.withheldCount).toBeGreaterThan(0);
      expect(sc.notice).toMatch(/took 30 of the 100 maxRecords slots/);
      expect(maxRecordsDirectives(sc.notice)).toEqual(['Continue with maxRecords']);
      expect(sc.notice).toMatch(/only a larger maxRecords reaches clips past this page's cap/);
    });

    it('gives one maxRecords directive on a cut, capped window inside one clock hour', async () => {
      const all = Array.from({ length: 150 }, (_, i) =>
        longClip(i, secondsAfter('2024-01-16T01:00:05Z', i * 10)),
      );
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: measuredTvUpstream(all),
      } as unknown as tvServiceModule.GdeltTvService);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 100,
        sort: 'relevance',
        startDatetime: '20240116010000',
        endDatetime: '20240116012000',
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.withheldCount).toBeGreaterThan(0);
      expect(sc.continuationWindows).toHaveLength(2);
      expect(sc.notice).toMatch(/aired outside/);
      expect(maxRecordsDirectives(sc.notice)).toEqual(['Continue with maxRecords']);
    });

    /**
     * A relevance cut on a 38-minute window: its halves are 19 minutes, which GDELT TV rejects
     * as sent, so every half is requested as its whole hour and trimmed back to its own seconds.
     */
    it('reaches every clip of a 38-minute relevance window by following halves until each fits', async () => {
      const all = Array.from({ length: 131 }, (_, i) =>
        longClip(i, secondsAfter('2024-01-16T01:00:00Z', 1 + i * 17)),
      );
      const upstream = measuredTvUpstream(all);
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: upstream,
      } as unknown as tvServiceModule.GdeltTvService);
      const base = { query: 'x', stations: ['CNN'], maxRecords: 3000, sort: 'relevance' as const };
      const queue = [{ startDatetime: '20240116010000', endDatetime: '20240116013800' }];
      const seen = new Set<string>();
      let calls = 0;
      while (queue.length > 0) {
        const window = queue.shift()!;
        const result = await runToolContract(
          gdeltGetTvClips,
          gdeltGetTvClips.input.parse({ ...base, ...window }),
        );
        calls++;
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as ClipPage;
        for (const c of sc.clips) seen.add(c.archiveUrl);
        if (sc.continuationWindows) queue.push(...sc.continuationWindows);
        else expect(sc).not.toHaveProperty('withheldCount');
        expect(calls).toBeLessThan(50);
      }
      expect(calls).toBeGreaterThan(1);
      expect(seen.size).toBe(131);
    });

    /**
     * The page is cut and capped below the ceiling: its withheld clips were fetched and lie inside
     * the window, so a sub-hour half reaches them; raising maxRecords reaches the rest of the hour.
     */
    it('splits a capped, cut relevance window inside one clock hour, and a half reaches withheld clips', async () => {
      const all = Array.from({ length: 150 }, (_, i) =>
        longClip(i, secondsAfter('2024-01-16T01:00:00Z', 1 + i * 10)),
      );
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: measuredTvUpstream(all),
      } as unknown as tvServiceModule.GdeltTvService);
      const base = { query: 'x', stations: ['CNN'], maxRecords: 100, sort: 'relevance' as const };
      const result = await runToolContract(gdeltGetTvClips, {
        ...base,
        startDatetime: '20240116010000',
        endDatetime: '20240116013800',
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.withheldCount).toBeGreaterThan(0);
      expect(sc.continuationWindows).toEqual([
        { startDatetime: '20240116010000', endDatetime: '20240116011900' },
        { startDatetime: '20240116011901', endDatetime: '20240116013800' },
      ]);
      expect(sc.notice).toMatch(/clips past that cap are out of reach of any narrower window/);
      expect(maxRecordsDirectives(sc.notice)).toEqual(['Continue with maxRecords']);
      expect(sc.notice).not.toMatch(/not retrievable/);

      const emitted = new Set(sc.clips.map((c) => c.archiveUrl));
      const reached: string[] = [];
      for (const half of sc.continuationWindows!) {
        const page = await runToolContract(gdeltGetTvClips, { ...base, ...half });
        for (const c of (page.structuredContent as ClipPage).clips) {
          if (!emitted.has(c.archiveUrl)) reached.push(c.archiveUrl);
        }
      }
      expect(reached.length).toBeGreaterThan(0);
    });

    it('splits a relevance cut on the hour, so the halves share no clip and cover the window', async () => {
      /** ~520-byte clips: 102 of them overflow the budget, each half's 51 fit. */
      const midClip = (i: number, date: string) => ({
        ...CLIP_AT(date, i),
        snippet: 'x'.repeat(350),
      });
      const clips = [
        ...Array.from({ length: 50 }, (_, i) => midClip(i, secondsAfter(DAY, 30 + i * 70))),
        midClip(50, '2024-07-01T00:59:59Z'),
        midClip(51, '2024-07-01T01:00:00Z'),
        ...Array.from({ length: 50 }, (_, i) =>
          midClip(52 + i, secondsAfter('2024-07-01T01:00:00Z', 30 + i * 70)),
        ),
      ];
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: measuredTvUpstream(clips),
      } as unknown as tvServiceModule.GdeltTvService);
      const base = { query: 'x', stations: ['CNN'], maxRecords: 3000, sort: 'relevance' as const };
      const first = await runToolContract(gdeltGetTvClips, {
        ...base,
        startDatetime: '20240701000000',
        endDatetime: '20240701020000',
      });
      const halves = (first.structuredContent as ClipPage).continuationWindows!;
      expect(halves).toEqual([
        { startDatetime: '20240701000000', endDatetime: '20240701005959' },
        { startDatetime: '20240701010000', endDatetime: '20240701020000' },
      ]);
      const emitted: Array<Set<string>> = [];
      for (const half of halves) {
        const page = await runToolContract(gdeltGetTvClips, { ...base, ...half });
        const sc = page.structuredContent as ClipPage;
        expect(sc).not.toHaveProperty('withheldCount');
        emitted.push(new Set(sc.clips.map((c) => c.archiveUrl)));
      }
      const [a, b] = emitted as [Set<string>, Set<string>];
      expect([...a].filter((url) => b.has(url))).toEqual([]);
      expect(new Set([...a, ...b]).size).toBe(clips.length);
    });
  });

  /**
   * GDELT TV answers a window in whole clock hours — the start floored to the hour, the end's
   * hour included in full — and rejects a window under 30 minutes. The request goes out widened
   * to whole hours; the caller's exact window is what the drop keeps.
   */
  describe('the window sent to GDELT', () => {
    it.each([
      ['20240116010500', '20240116012000', '20240116010000', '20240116015959'],
      ['20240116010500', '20240116031000', '20240116010000', '20240116031000'],
      ['20240116010000', '20240116020000', '20240116010000', '20240116015959'],
    ])('requests %s–%s as %s–%s', async (start, end, sentStart, sentEnd) => {
      const upstream = vi.fn().mockResolvedValue([]);
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: upstream,
      } as unknown as tvServiceModule.GdeltTvService);
      await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        startDatetime: start,
        endDatetime: end,
      });
      expect(upstream).toHaveBeenCalledWith(
        expect.objectContaining({ startDatetime: sentStart, endDatetime: sentEnd }),
        expect.anything(),
      );
    });

    it('answers a 15-minute window with only the clips inside it', async () => {
      const all = Array.from({ length: 12 }, (_, i) =>
        CLIP_AT(secondsAfter('2024-01-16T01:00:00Z', i * 300), i),
      );
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: measuredTvUpstream(all),
      } as unknown as tvServiceModule.GdeltTvService);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        sort: 'dateAsc',
        startDatetime: '20240116011000',
        endDatetime: '20240116012500',
      });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as ClipPage).clips.map((c) => c.date)).toEqual([
        '2024-01-16T01:10:00Z',
        '2024-01-16T01:15:00Z',
        '2024-01-16T01:20:00Z',
        '2024-01-16T01:25:00Z',
      ]);
    });

    /**
     * A window ending exactly on the hour is sent a second short, so GDELT does not answer the
     * whole next hour for one second of the window. The clip at that exact end second is not
     * fetched — consistent with GDELT's documented exclusive ENDDATETIME.
     */
    it('leaves out the end second of a window ending exactly on the hour, and fetches only the hour before', async () => {
      const all = [
        CLIP_AT('2024-01-16T00:59:59Z', 1),
        CLIP_AT('2024-01-16T01:00:00Z', 2),
        CLIP_AT('2024-01-16T01:30:00Z', 3),
      ];
      const upstream = measuredTvUpstream(all);
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvClips: upstream,
      } as unknown as tvServiceModule.GdeltTvService);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        sort: 'dateDesc',
        startDatetime: '20240116000000',
        endDatetime: '20240116010000',
      });
      expect((result.structuredContent as ClipPage).clips.map((c) => c.date)).toEqual([
        '2024-01-16T00:59:59Z',
      ]);
      expect(result.structuredContent).not.toHaveProperty('notice');
    });
  });

  /**
   * GDELT TV answers whole clock hours, so it returns clips aired outside a window whose edges
   * are not on the hour. Clips dated outside the resolved window are dropped before the budget,
   * and the notice says how many — as an expected edge effect, not missing results.
   */
  describe('clips dated outside the resolved window', () => {
    const WINDOW = { startDatetime: '20240701000000', endDatetime: '20240701120000' };

    it('drops them from both surfaces and counts them in the notice', async () => {
      const inside = [CLIP_AT('2024-07-01T11:59:00Z', 1), CLIP_AT('2024-07-01T06:00:00Z', 2)];
      const outside = [CLIP_AT('2024-07-01T12:49:08Z', 3), CLIP_AT('2024-07-01T12:10:00Z', 4)];
      mockClips([...outside, ...inside]);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.clips).toEqual(inside);
      expect(sc.totalCount).toBe(2);
      expect(sc).not.toHaveProperty('withheldCount');
      expect(sc.notice).toMatch(
        /GDELT answers TV windows in whole clock hours, so it also returned 2 clips aired outside 20240701000000–20240701120000; they were dropped/,
      );
      // A caller following a continuation window must not read its own seam as a fault.
      expect(sc.notice).toMatch(/not a sign of missing results/);
      const text = contentText(result);
      expect(text).not.toContain('12:49:08');
    });

    it('still detects the maxRecords cap from the upstream count before the drop', async () => {
      const inside = Array.from({ length: 6 }, (_, i) => CLIP_AT(`2024-07-01T0${i}:00:00Z`, i));
      const outside = Array.from({ length: 4 }, (_, i) =>
        CLIP_AT(`2024-07-01T12:1${i}:00Z`, 10 + i),
      );
      mockClips([...outside, ...inside]);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        maxRecords: 10,
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.clips).toHaveLength(6);
      expect(sc.notice).toMatch(/maxRecords cap reached/);
      expect(sc.notice).toMatch(/returned 4 clips aired outside 20240701000000–20240701120000/);
    });

    it('returns an empty page with the empty-result guidance when every returned clip is outside', async () => {
      mockClips(Array.from({ length: 5 }, (_, i) => CLIP_AT(`2024-07-01T12:3${i}:00Z`, i)));
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.clips).toEqual([]);
      expect(sc.totalCount).toBe(0);
      expect(sc.notice).toMatch(/returned 5 clips aired outside 20240701000000–20240701120000/);
      expect(sc.notice).toMatch(/No clip aired inside the window/);
      expect(sc.notice).toMatch(/gdelt_list_tv_stations, or broaden the query/);
      expect(sc.notice).not.toMatch(/No TV clips matched/);
      expect(contentText(result)).toContain('No clips returned.');
    });

    /**
     * A timespan is resolved by GDELT on its own clock, which the server cannot observe, so
     * dropping by the server's resolution of it could remove clips GDELT returned for the
     * caller's own timespan. Only explicit windows drop.
     */
    it('drops nothing on a timespan call', async () => {
      const justNow = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const clips = [CLIP_AT('2015-01-01T00:00:00Z', 1), CLIP_AT(justNow, 2)];
      mockClips(clips);
      const result = await runToolContract(gdeltGetTvClips, {
        query: 'x',
        stations: ['CNN'],
        timespan: '1y',
      });
      const sc = result.structuredContent as ClipPage;
      expect(sc.clips).toEqual(clips);
      expect(sc).not.toHaveProperty('notice');
    });
  });
});

// ─── Fixtures and fakes ───────────────────────────────────────────────────────

const BUDGET = 48_000;
const DAY = '2024-07-01T00:00:00Z';
const NOON = '2024-07-01T12:00:00Z';
const HEADING = '## GDELT TV Clips';

type Clip = typeof CLIP;
type ClipPage = {
  clips: Clip[];
  totalCount: number;
  withheldCount?: number;
  notice?: string;
  continuationWindows?: Array<{ startDatetime: string; endDatetime: string }>;
};

function mockClips(clips: unknown[]) {
  vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
    getTvClips: vi.fn().mockResolvedValue(clips),
  } as unknown as tvServiceModule.GdeltTvService);
}

function utf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/** What one clip adds to each surface, measured through the tool's own format(). */
function chargeOf(clip: Clip): number {
  const text = (gdeltGetTvClips.format!({ clips: [clip] })[0] as { text: string }).text;
  return Math.max(utf8(JSON.stringify(clip)) + 1, utf8(text) - utf8(HEADING));
}

/** ISO 8601 (second precision) `seconds` after `iso`. */
function secondsAfter(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString().replace('.000Z', 'Z');
}

function gdeltAt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

function CLIP_AT(date: string, i: number): Clip {
  return { ...CLIP, date, archiveUrl: `https://archive.org/details/CLIP_${i}` };
}

/** Every sentence in a notice that tells the caller to change maxRecords. */
function maxRecordsDirectives(notice: string | undefined): string[] {
  return [...(notice ?? '').matchAll(/(?:Continue with|[Rr]aise|[Ii]ncrease) maxRecords/g)].map(
    ([match]) => match,
  );
}

/** A clip with a long multi-byte snippet and long URLs — heavier than any live sample. */
function longClip(i: number, date: string): Clip {
  return {
    show: `Morning Report — édition spéciale ${i}`,
    station: 'CNN',
    date,
    snippet: `気候変動についての報道 ${'ü'.repeat(120)} ${'世界の天気'.repeat(30)} clip ${i}`,
    archiveUrl: `https://archive.org/details/CNNW_20240701_${String(i).padStart(4, '0')}_${'Morning_Report_'.repeat(4)}#start/${i}/end/${i + 35}`,
    thumbnail: `https://archive.org/download/CNNW_${i}/${'thumbs/'.repeat(8)}${i}.jpg`,
  };
}

/** `count` clips each charged exactly `charge` bytes, found by padding the snippet. */
function exactFitClips(count: number, charge: number): Clip[] {
  return Array.from({ length: count }, (_, i) => {
    const base = CLIP_AT(secondsAfter(DAY, i), 1000 + i);
    for (let pad = 0; pad < charge; pad++) {
      const clip = { ...base, snippet: `s${'x'.repeat(pad)}` };
      if (chargeOf(clip) === charge) return clip;
    }
    throw new Error(`no padding gives a ${charge}-byte clip`);
  });
}

function parseGdelt(v: string): number {
  return Date.parse(
    `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:${v.slice(12, 14)}Z`,
  );
}

/** Seconds an input's explicit window spans. */
function spanSeconds(input: {
  startDatetime?: string | undefined;
  endDatetime?: string | undefined;
}): number {
  return (parseGdelt(input.endDatetime!) - parseGdelt(input.startDatetime!)) / 1000;
}

/**
 * A TV clip-gallery stand-in built from the live-measured window rules: a request spanning
 * under 30 minutes is rejected with GDELT's own "Timespan is too short." body (classified by
 * the real parser); otherwise the start is floored to the clock hour and the end's hour is
 * included in full, on clip time. Orders by the requested sort (relevance is a fixed shuffle)
 * and applies maxRecords.
 */
function measuredTvUpstream(all: Clip[]) {
  const HOUR = 3_600_000;
  return vi.fn(async (params: tvServiceModule.TvClipParams) => {
    const start = parseGdelt(params.startDatetime!);
    const end = parseGdelt(params.endDatetime!);
    if (end - start < 30 * 60_000) parseGdeltJson('Timespan is too short.', 'GDELT TV');
    const from = Math.floor(start / HOUR) * HOUR;
    const until = Math.floor(end / HOUR) * HOUR + HOUR;
    const matched = all
      .map((clip, index) => ({ clip, index, at: Date.parse(clip.date) }))
      .filter(({ at }) => at >= from && at < until);
    if (params.sort === 'dateDesc') matched.sort((a, b) => b.at - a.at || a.index - b.index);
    else if (params.sort === 'dateAsc') matched.sort((a, b) => a.at - b.at || a.index - b.index);
    else matched.sort((a, b) => ((a.index * 7919) % 613) - ((b.index * 7919) % 613));
    return matched.slice(0, params.maxRecords).map(({ clip }) => clip);
  });
}
