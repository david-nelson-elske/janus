/**
 * @janus/http — HTTP surface, route derivation, SSR, SSE, and app bootstrap.
 */

export { createApp } from './create-app';
export type { App, AppConfig } from './create-app';
export { createHttpApp } from './hono-app';
export type { CreateHttpAppConfig } from './hono-app';
export { deriveRouteTable } from './route-table';
export type { RouteEntry } from './route-table';
export { apiSurface } from './surface';
export type { ApiSurfaceConfig, OidcSurfaceConfig } from './surface';
export { createAuthRoutes, clearDiscoveryCache, SESSION_COOKIE } from './auth-routes';
export type { AuthRoutesConfig, OidcProviderRecord, OidcEndpoints } from './auth-routes';
export { resolveSessionIdentity } from './session-resolve';
export { resolvePageRoute, buildNavLinks } from './page-router';
export type { PageRoute } from './page-router';
export { createSseHandler } from './sse-handler';
export type { SseHandlerConfig } from './sse-handler';
export { renderPage } from './ssr-renderer';
export type { RenderPageConfig } from './ssr-renderer';
export { createPageHandler } from './page-handler';
export type { PageHandlerConfig } from './page-handler';
