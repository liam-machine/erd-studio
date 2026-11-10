/**
 * usePrefersReducedMotion — true while the operating system's reduce-motion
 * setting is on (`prefers-reduced-motion: reduce`).
 *
 * The relationship arrows are SMIL animations, which CSS media queries cannot
 * stop, so `EdgeFlow` asks this hook and draws a still frame instead. One
 * module-level media query list serves every caller; false where
 * `window.matchMedia` does not exist (tests, server rendering).
 *
 * VS Code's own `workbench.reduceMotion` setting does not reach webviews, so
 * only the OS setting counts.
 */

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

let cachedFor: unknown = null;
let cachedList: MediaQueryList | null = null;

function mediaList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  // Re-create when matchMedia itself was replaced (tests stub it per case).
  if (cachedFor !== window.matchMedia) {
    cachedFor = window.matchMedia;
    cachedList = window.matchMedia(QUERY) ?? null;
  }
  return cachedList;
}

function subscribe(onChange: () => void): () => void {
  const list = mediaList();
  if (!list) return () => {};
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }
  // Safari before 14 has only the deprecated listener API.
  list.addListener?.(onChange);
  return () => list.removeListener?.(onChange);
}

function getSnapshot(): boolean {
  return mediaList()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
