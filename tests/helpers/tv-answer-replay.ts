/**
 * @fileoverview Recorded GDELT TV answers replayed at the fetch seam. A real GdeltTvService builds
 * every request, and each one gets the body GDELT returned for exactly that request when it was
 * recorded (`tests/fixtures/tv/`), so a TV tool test sees both what the tool sends upstream and
 * what GDELT answers it. The station catalog request is answered from the live catalog fixture.
 * @module tests/helpers/tv-answer-replay
 */

import { readFileSync } from 'node:fs';
import { onTestFinished, vi } from 'vitest';
import * as gdeltFetchModule from '@/services/gdelt/gdelt-fetch.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';
import type { RawTvStation, TvStation } from '@/services/gdelt/types.js';

/** The live 159-station catalog (captured 2026-09-24), back in the raw `stationdetails` shape. */
export const RAW_TV_CATALOG = {
  station_details: (
    JSON.parse(
      readFileSync(new URL('../fixtures/tv-station-catalog.json', import.meta.url), 'utf8'),
    ) as { stations: TvStation[] }
  ).stations.map(
    (s): RawTvStation => ({
      StationID: s.stationId,
      Description: s.description,
      Market: s.market,
      Network: s.network,
      StartDate: s.startDate.replaceAll('-', ''),
      EndDate: s.endDate.replaceAll('-', ''),
    }),
  ),
};

/**
 * A body GDELT TV returned, recorded on 2026-11-18 and stored verbatim (reformatted only) as
 * `tests/fixtures/tv/<name>.json`. Each name spells out the request: query and stations, mode,
 * datanorm, dateres when sent, startdatetime, and enddatetime.
 */
export function recordedTvAnswer(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/tv/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown;
}

/** One request to GDELT TV — every parameter except `format` — and the body it returns. */
export type TvExchange = { request: Readonly<Record<string, string>>; answer: unknown };

/**
 * Serve the running test's TV tool calls through a real GdeltTvService: a request whose
 * parameters equal one exchange's exactly gets that exchange's answer, and any other request
 * fails the call. Returns the parameters of every request sent besides the station catalog's,
 * in order.
 */
export function replayTvExchanges(exchanges: readonly TvExchange[]): URLSearchParams[] {
  const sent: URLSearchParams[] = [];
  const fetchSpy = vi
    .spyOn(gdeltFetchModule, 'gdeltFetch')
    .mockImplementation(async (_url, params) => {
      if (params.get('mode') === 'stationdetails') return RAW_TV_CATALOG;
      sent.push(new URLSearchParams(params));
      const exchange = exchanges.find(({ request }) => isRequest(request, params));
      if (!exchange) throw new Error(`No recorded GDELT TV answer for ${params.toString()}`);
      return exchange.answer;
    });
  const serviceSpy = vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(
    new tvServiceModule.GdeltTvService(
      {} as never,
      {} as never,
      {
        baseUrl: 'https://api.gdeltproject.org/api/v2',
        requestTimeoutMs: 60_000,
      } as never,
    ),
  );
  onTestFinished(() => {
    fetchSpy.mockRestore();
    serviceSpy.mockRestore();
  });
  return sent;
}

function isRequest(request: TvExchange['request'], params: URLSearchParams): boolean {
  const keys = [...params.keys()].filter((key) => key !== 'format');
  return (
    keys.length === Object.keys(request).length &&
    keys.every((key) => params.get(key) === request[key])
  );
}
