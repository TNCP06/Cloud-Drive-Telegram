"use client";

import { getGallery } from "@/app/actions";
import type { GalleryPart } from "./types";

// Album gallery cache (array of GalleryPart objects per part) for one browser session.
// Part thumbnails never change from the web side (only the indexing bot writes them),
// so it's safe to keep them in memory until a full page reload.
// This eliminates redundant Turso reads every time a preview is opened — the main
// cause of lag when opening albums and reopening the same file repeatedly.
const cache = new Map<number, GalleryPart[]>();
const inflight = new Map<number, Promise<GalleryPart[]>>();

// Synchronous cache lookup — enables instant render without a loading flash.
export function getCachedGallery(id: number): GalleryPart[] | undefined {
  return cache.get(id);
}

// Load gallery: return from cache if available, otherwise fetch once and store.
// `inflight` prevents two parallel fetches for the same id.
export function loadGallery(id: number): Promise<GalleryPart[]> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(id);
  if (!p) {
    p = getGallery(id)
      .then((g) => {
        cache.set(id, g);
        inflight.delete(id);
        return g;
      })
      .catch((e) => {
        inflight.delete(id);
        throw e;
      });
    inflight.set(id, p);
  }
  return p;
}

// Background prefetch (fire-and-forget) — warms the cache before a preview is opened.
export function prefetchGallery(id: number): void {
  if (!cache.has(id) && !inflight.has(id)) void loadGallery(id).catch(() => {});
}
