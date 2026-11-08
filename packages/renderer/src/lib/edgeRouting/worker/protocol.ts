/**
 * Messages between a canvas and its line-routing worker (`worker/entry.ts`).
 * Everything here is structured-clone safe: plain objects, arrays and Maps.
 */
import type { LineStyle } from '../lineStyle';
import type { RoutedEdge, RoutingInput } from '../types';

/** Route `input` in `style`. `seq` comes back on the answer, so a canvas can drop a stale one. */
export interface WorkerRouteRequest {
  type: 'route';
  seq: number;
  input: RoutingInput;
  style: LineStyle;
  zoom: number;
}

/** The worker's answer to one request. */
export interface WorkerRouteResult {
  seq: number;
  edges: Map<string, RoutedEdge>;
  /** How long the pass took in the worker. */
  millis: number;
  /** A router or renderer error in this pass (the routes then leave those lines out). */
  error?: string;
}
