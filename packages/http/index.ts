/**
 * @janus/http — HTTP surface, route derivation, SSR, SSE, and app bootstrap.
 */

export type { AuthRoutesConfig, OidcEndpoints, OidcProviderRecord } from './auth-routes';
export { clearDiscoveryCache, createAuthRoutes, SESSION_COOKIE } from './auth-routes';
export type { App, AppConfig } from './create-app';
export { createApp } from './create-app';
export type { CreateHttpAppConfig } from './hono-app';
export { createHttpApp } from './hono-app';
export type { PageHandlerConfig } from './page-handler';
export { createPageHandler, parseListQueryParams } from './page-handler';
export type { PageRoute } from './page-router';
export { buildNavLinks, resolvePageRoute } from './page-router';
export type { RouteEntry } from './route-table';
export { deriveRouteTable } from './route-table';
export { resolveSessionIdentity } from './session-resolve';
export type { ShellComponent, ShellProps } from './shells';
export { DefaultNav, DefaultShell, MinimalShell } from './shells';
export type { SseHandlerConfig } from './sse-handler';
export { createSseHandler } from './sse-handler';
export type {
  LayoutConfig,
  RenderPageConfig,
  ThemeConfig,
  ThemeFontsConfig,
} from './ssr-renderer';
export { renderPage } from './ssr-renderer';
export type { ApiSurfaceConfig, OidcSurfaceConfig } from './surface';
export { apiSurface } from './surface';
