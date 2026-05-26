/**
 * @fileoverview Tests for gdelt_list_tv_stations tool.
 * @module tests/tools/list-tv-stations.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltListTvStations } from '@/mcp-server/tools/definitions/list-tv-stations.tool.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';

const STATIONS = [
  {
    stationId: 'CNN',
    description: 'CNN',
    market: 'National',
    network: 'CNN',
    startDate: '2009-07-02',
    endDate: '2024-10-31',
    isActive: false,
  },
  {
    stationId: 'FOXNEWS',
    description: 'Fox News',
    market: 'National',
    network: 'Fox News',
    startDate: '2009-07-02',
    endDate: '2024-10-31',
    isActive: false,
  },
  {
    stationId: 'KNTV',
    description: 'NBC Bay Area',
    market: 'San Francisco',
    network: 'NBC',
    startDate: '2010-01-01',
    endDate: '2024-10-31',
    isActive: false,
  },
];

describe('gdeltListTvStations', () => {
  beforeEach(() => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      listStations: vi.fn().mockResolvedValue(STATIONS),
    } as unknown as tvServiceModule.GdeltTvService);
  });

  it('returns sorted station list with counts', async () => {
    const ctx = createMockContext({ errors: gdeltListTvStations.errors });
    const input = gdeltListTvStations.input.parse({});
    const result = await gdeltListTvStations.handler(input, ctx);
    expect(result.totalCount).toBe(3);
    expect(result.stations).toHaveLength(3);
    // Sorted by stationId: CNN, FOXNEWS, KNTV
    expect(result.stations[0]?.stationId).toBe('CNN');
    expect(result.stations[1]?.stationId).toBe('FOXNEWS');
    expect(result.stations[2]?.stationId).toBe('KNTV');
  });

  it('counts active stations correctly', async () => {
    const activeStation = { ...STATIONS[0]!, isActive: true };
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      listStations: vi.fn().mockResolvedValue([activeStation, STATIONS[1]!, STATIONS[2]!]),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltListTvStations.errors });
    const input = gdeltListTvStations.input.parse({});
    const result = await gdeltListTvStations.handler(input, ctx);
    expect(result.activeCount).toBe(1);
  });

  it('throws no_stations when service returns empty list', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      listStations: vi.fn().mockResolvedValue([]),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltListTvStations.errors });
    const input = gdeltListTvStations.input.parse({});
    await expect(gdeltListTvStations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_stations' },
    });
  });

  it('formats output with startDate and endDate for national stations', () => {
    const output = {
      stations: STATIONS,
      activeCount: 0,
      totalCount: 3,
    };
    const blocks = gdeltListTvStations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CNN');
    expect(text).toContain('FOXNEWS');
    expect(text).toContain('KNTV');
    expect(text).toContain('2009-07-02');
    expect(text).toContain('2024-10-31');
    expect(text).toContain('National');
    expect(text).toContain('San Francisco');
    expect(text).toContain('3');
    expect(text).toContain('0');
  });

  it('shows active marker for active stations in format output', () => {
    const withActive = [{ ...STATIONS[0]!, isActive: true }, ...STATIONS.slice(1)];
    const output = { stations: withActive, activeCount: 1, totalCount: 3 };
    const blocks = gdeltListTvStations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('✓ Active');
  });

  it('groups national and local stations in format output', () => {
    const output = { stations: STATIONS, activeCount: 0, totalCount: 3 };
    const blocks = gdeltListTvStations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('National Networks');
    expect(text).toContain('Local/Regional Stations');
  });
});
