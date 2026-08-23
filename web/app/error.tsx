"use client";

import { useEffect } from "react";
import { Icon } from "@/lib/icons";

// Error boundary per-segment: muncul saat server component / server action gagal —
// menggantikan crash dengan UI yang bisa "Coba lagi" tanpa reload penuh. Pesan asli
// error ditampilkan kalau tersedia; di production Next.js meredaksi pesan error server
// menjadi teks generik, jadi kode digest selalu ikut ditampilkan agar bisa dicocokkan
// dengan log (`docker logs` / Vercel logs) untuk mengetahui penyebab sebenarnya.
export default function Error({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const known = error.message && !/^An error occurred in the Server (Components|Actions)/.test(error.message);

  return (
    <div className="err-wrap">
      <div className="err-card">
        <Icon name="warn" size={40} />
        <h1>Tidak bisa memuat data</h1>
        <p>
          {known
            ? error.message
            : "Koneksi ke server (database) sepertinya terputus. Periksa internet lalu coba lagi — proses upload di laptop tidak terpengaruh dan tetap berjalan."}
        </p>
        {error.digest && (
          <p style={{ fontSize: 12, color: "var(--muted)" }}>
            Kode error: <code>{error.digest}</code>
          </p>
        )}
        <div className="err-actions">
          <button className="btn primary" onClick={() => location.reload()}>
            <Icon name="restore" size={16} /> Muat ulang halaman
          </button>
        </div>
      </div>
    </div>
  );
}
