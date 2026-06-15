"use client";

// Fallback paling luar (mengganti root layout) bila terjadi error fatal saat render.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="id">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#f4f1ea",
          color: "#2a2620",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420, padding: 24 }}>
          <h1 style={{ fontWeight: 500 }}>Terjadi kesalahan</h1>
          <p style={{ color: "#6b6457", lineHeight: 1.6 }}>
            Koneksi mungkin terputus. Proses upload di laptop tidak terpengaruh.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 12,
              padding: "9px 18px",
              borderRadius: 8,
              border: "none",
              background: "#2a2620",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Coba lagi
          </button>
        </div>
      </body>
    </html>
  );
}
