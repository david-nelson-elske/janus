/**
 * @janus/router — v1 route → loader → projection → binding → manifest
 * pipeline.
 *
 * Spec: .planning/CONTROLLER-API-AND-ROUTER.md §9 (in Perspicuity).
 */

export type {
  Binding,
  BindingContext,
  DefineRouteConfig,
  DefineRouteContext,
  HttpMethod,
  LoaderResult,
} from './define-route';
export { defineRoute } from './define-route';
