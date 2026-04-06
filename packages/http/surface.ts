/**
 * apiSurface() — Produces an InitiatorConfig with HTTP transport participation records.
 *
 * The initiator's participations (http-receive, http-identity, http-respond) join
 * with each entity's participations at compile time to produce complete HTTP pipelines.
 */

import type { Identity, InitiatorConfig, ParticipationRecord } from '@janus/core';
import type { HttpIdentityConfig } from '@janus/pipeline';

export type { OidcConfig as OidcSurfaceConfig } from '@janus/pipeline';

export interface ApiSurfaceConfig {
  readonly name?: string;
  readonly basePath?: string;
  readonly identity?: HttpIdentityConfig;
}

/**
 * Create an API surface initiator for HTTP dispatch.
 */
export function apiSurface(config?: ApiSurfaceConfig): {
  readonly initiator: InitiatorConfig;
  readonly basePath: string;
} {
  const name = config?.name ?? 'api-surface';
  const basePath = config?.basePath ?? '/api';

  const participations: ParticipationRecord[] = [
    {
      source: name,
      handler: 'http-receive',
      order: 5,
      transactional: false,
      config: { basePath },
    },
    {
      source: name,
      handler: 'http-identity',
      order: 6,
      transactional: false,
      config: config?.identity ?? {},
    },
    {
      source: name,
      handler: 'http-respond',
      order: 80,
      transactional: false,
      config: {},
    },
  ];

  return {
    initiator: {
      name,
      origin: 'consumer',
      participations,
    },
    basePath,
  };
}
