/**
 * @fileoverview Server-specific configuration parsed from environment variables.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .default('https://api.gdeltproject.org/api/v2')
    .describe('Base URL for GDELT APIs'),
  requestDelayMs: z.coerce
    .number()
    .int()
    .min(0)
    .default(5300)
    .describe(
      "Minimum milliseconds between API requests to satisfy GDELT's 1 req/5s limit, with headroom above the 5000ms floor for clock jitter",
    ),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .default(60000)
    .describe(
      'Deadline in milliseconds for a single GDELT request. GDELT is a bulk analytical API over a global news corpus, not a low-latency service — a broad article or timeline query legitimately runs for tens of seconds. The whole call, retries included, is bounded at twice this value',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'GDELT_BASE_URL',
    requestDelayMs: 'GDELT_REQUEST_DELAY_MS',
    requestTimeoutMs: 'GDELT_REQUEST_TIMEOUT_MS',
  });
  return _config;
}
