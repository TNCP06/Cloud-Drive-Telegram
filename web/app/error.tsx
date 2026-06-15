"use client";

import { useEffect } from "react";
import { Icon } from "@/lib/icons";

// Error boundary per-segment: muncul saat server component gagal (mis. Turso/koneksi
// putus) — menggantikan crash dengan UI yang bisa "Coba lagi" tanpa reload penuh.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="err-wrap">
      <div className="err-card">
        <Icon name="warn" size={40} />
        <h1>Tidak bisa memuat data</h1>
        <p>
          Koneksi ke server (Turso) sepertinya terputus. Periksa internet lalu coba lagi —
          proses upload di laptop <b>tidak terpengaruh</b> dan tetap berjalan.
        </p>
        <div className="err-actions">
          <button className="btn primary" onClick={() => reset()}>
            <Icon name="restore" size={16} /> Coba lagi
          </button>
          <button className="btn subtle" onClick={() => location.reload()}>
            Muat ulang halaman
          </button>
        </div>
      </div>
    </div>
  );
}
