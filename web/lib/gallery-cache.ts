"use client";

import { getGallery } from "@/app/actions";

// Cache galeri album (array data-URL base64 per part) selama satu sesi browser.
// Thumbnail part TIDAK pernah berubah dari sisi web (hanya bot indexing yang
// menulisnya), jadi aman disimpan di memori sampai reload penuh halaman.
// Tujuannya menghilangkan baca-ulang Turso tiap kali preview dibuka — penyebab
// jeda saat membuka album & lambat saat membuka file yang sama berulang kali.
const cache = new Map<number, string[]>();
const inflight = new Map<number, Promise<string[]>>();

// Ambil galeri dari cache secara sinkron (untuk render instan tanpa flash).
export function getCachedGallery(id: number): string[] | undefined {
  return cache.get(id);
}

// Muat galeri: kembalikan dari cache bila ada, kalau belum fetch sekali lalu
// simpan. `inflight` mencegah dua fetch paralel untuk id yang sama.
export function loadGallery(id: number): Promise<string[]> {
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

// Prefetch latar (fire-and-forget) — mengisi cache sebelum preview dibuka.
export function prefetchGallery(id: number): void {
  if (!cache.has(id) && !inflight.has(id)) void loadGallery(id).catch(() => {});
}
