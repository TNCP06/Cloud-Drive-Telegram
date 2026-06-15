"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { KINDS, TAG_COLORS } from "@/lib/kinds";
import { fmtSize, fmtDate, trashDaysLeft } from "@/lib/format";
import { getCachedGallery, loadGallery } from "@/lib/gallery-cache";
import type { DriveFile, Kind, Tag } from "@/lib/types";

export function PreviewDrawer({
  item,
  tags,
  deepLink,
  hasPrevFile = false,
  hasNextFile = false,
  onNavigateFile,
  onClose,
  onStar,
  onTrash,
  onRestore,
  onSave,
}: {
  item: DriveFile;
  tags: Tag[];
  deepLink: string | null;
  hasPrevFile?: boolean;
  hasNextFile?: boolean;
  onNavigateFile?: (delta: number) => void;
  onClose: () => void;
  onStar: (item: DriveFile) => void;
  onTrash: (item: DriveFile) => void;
  onRestore: (item: DriveFile) => void;
  onSave: (item: DriveFile, input: { title: string; kind: Kind; tags: string }) => void;
}) {
  const meta = KINDS[item.kind];
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.name);
  const [kind, setKind] = useState<Kind>(item.kind);
  const [tagsText, setTagsText] = useState(itemTags.map((t) => t.name).join(", "));
  // Inisialisasi dari cache → bila galeri sudah pernah dimuat (atau di-prefetch),
  // semua foto tampil instan pada render pertama tanpa flash cover dulu.
  const [gallery, setGallery] = useState<string[] | null>(() =>
    item.kind === "media" && item.parts > 1 ? getCachedGallery(item.id) ?? null : null
  );
  const [activeIdx, setActiveIdx] = useState(0);
  // Panel detail tersembunyi di balik tombol titik-3; foto tampil full-screen.
  const [showDetails, setShowDetails] = useState(false);

  // Reset form bila item yang dibuka berganti (atau keluar dari mode edit).
  useEffect(() => {
    setEditing(false);
    setShowDetails(false);
    setTitle(item.name);
    setKind(item.kind);
    setTagsText(item.tags.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean).join(", "));
  }, [item.id, item.name, item.kind, item.tags, tags]);

  // Galeri album dimuat on-demand (hanya media multi-part). Cover (item.thumb)
  // tampil instan; strip thumbnail muncul setelah fetch selesai.
  useEffect(() => {
    setActiveIdx(0);
    if (item.kind === "media" && item.parts > 1) {
      // Cache hit → tampilkan langsung, tanpa menyentuh database sama sekali.
      const cached = getCachedGallery(item.id);
      if (cached) {
        setGallery(cached);
        return;
      }
      let alive = true;
      setGallery(null);
      loadGallery(item.id)
        .then((g) => alive && setGallery(g))
        .catch(() => alive && setGallery([]));
      return () => {
        alive = false;
      };
    }
    setGallery(null);
  }, [item.id, item.kind, item.parts]);

  const images = gallery && gallery.length > 0 ? gallery : item.thumb ? [item.thumb] : [];
  const active = images[Math.min(activeIdx, images.length - 1)];

  // Item tanpa gambar (game/arsip/dll) tetap tampil full-screen dengan ikon
  // besar + judul + titik-3; detail muncul saat titik-3 ditekan, sama seperti foto.
  const multi = images.length > 1;
  const last = images.length - 1;
  // Navigasi melewati batas part → lompat ke file tetangga di daftar.
  const canPrev = activeIdx > 0 || hasPrevFile;
  const canNext = activeIdx < last || hasNextFile;

  // Pindah ke part berikut/sebelumnya; bila sudah di ujung, pindah ke file lain.
  const go = (delta: number) => {
    if (delta > 0) {
      if (activeIdx < last) setActiveIdx(activeIdx + 1);
      else if (hasNextFile) onNavigateFile?.(1);
    } else {
      if (activeIdx > 0) setActiveIdx(activeIdx - 1);
      else if (hasPrevFile) onNavigateFile?.(-1);
    }
  };

  // Keyboard: Esc menutup (panel detail dulu bila terbuka); ←/→ ganti foto/file.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showDetails && !editing) setShowDetails(false);
        else onClose();
        return;
      }
      if (editing || showDetails) return;
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, showDetails, editing, activeIdx, last, hasPrevFile, hasNextFile]);

  const save = () => {
    if (!title.trim()) return;
    onSave(item, { title, kind, tags: tagsText });
  };

  // Titik-3 (kebab) sekarang hanya membuka metadata, read-only.
  const openDetails = () => {
    setEditing(false);
    setShowDetails(true);
  };

  // Tombol edit di bar atas membuka popup langsung dalam mode edit.
  const openEdit = () => {
    setEditing(true);
    setShowDetails(true);
  };

  return (
    <>
      {/* ---- Lapisan foto full-screen ---- */}
      <div className="viewer-scrim" onClick={onClose}></div>
      <div className={"viewer" + (multi ? " has-strip" : "") + (canPrev || canNext ? " has-nav" : "")}>
        <div className="viewer-stage" onClick={onClose}>
          {active ? (
            <img src={active} alt={item.name} onClick={(e) => e.stopPropagation()} />
          ) : (
            <Icon name={meta.icon} size={120} stroke={1.2} style={{ color: meta.tint }} />
          )}
        </div>

        {/* Kontrol melayang di atas foto. Tutup/edit/hapus di kiri, unduh/
            favorit/titik-3 di kanan — kedua sisi seimbang agar judul di tengah.
            Titik-3 hanya membuka metadata. */}
        <div className="viewer-top">
          <div className="viewer-tools">
            <button className="viewer-iconbtn" onClick={onClose} title="Tutup">
              <Icon name="close" size={17} />
            </button>
            {!item.trashed && (
              <>
                <button className="viewer-iconbtn" onClick={openEdit} title="Edit metadata">
                  <Icon name="edit" size={17} />
                </button>
                <button className="viewer-iconbtn" onClick={() => onTrash(item)} title="Hapus">
                  <Icon name="trash" size={17} />
                </button>
              </>
            )}
          </div>
          <span className="viewer-name">{item.version ? item.family : item.name}</span>
          <div className="viewer-tools">
            {item.trashed ? (
              <button className="viewer-iconbtn" onClick={() => onRestore(item)} title="Pulihkan">
                <Icon name="restore" size={17} />
              </button>
            ) : (
              <>
                {deepLink && (
                  <a
                    className="viewer-iconbtn"
                    href={deepLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Unduh"
                  >
                    <Icon name="download" size={17} />
                  </a>
                )}
                <button
                  className={"viewer-iconbtn" + (item.starred ? " on" : "")}
                  onClick={() => onStar(item)}
                  title="Favorit"
                >
                  <Icon name="star" size={17} fill={item.starred} />
                </button>
              </>
            )}
            <button className="viewer-iconbtn" onClick={openDetails} title="Detail metadata">
              <Icon name="kebab" size={17} />
            </button>
          </div>
        </div>

        {(canPrev || canNext) && (
          <>
            <button
              className="viewer-nav prev"
              onClick={() => go(-1)}
              disabled={!canPrev}
              title="Sebelumnya (←)"
            >
              <Icon name="back" size={22} />
            </button>
            <button
              className="viewer-nav next"
              onClick={() => go(1)}
              disabled={!canNext}
              title="Berikutnya (→)"
            >
              <Icon name="chevright" size={22} />
            </button>
          </>
        )}

        {multi && (
          <div className="viewer-strip">
            {images.map((src, i) => (
              <button
                key={i}
                className={"viewer-thumb" + (i === activeIdx ? " on" : "")}
                onClick={() => setActiveIdx(i)}
                title={`Bagian ${i + 1}`}
              >
                <img src={src} alt="" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ---- Panel detail (muncul saat tombol titik-3 ditekan) ---- */}
      {showDetails && (
        <>
          <div
            className="drawer-scrim"
            onClick={() => setShowDetails(false)}
          ></div>
          <div className="drawer">
            <div className="dv-head">
              <strong>{editing ? "Edit metadata" : "Detail"}</strong>
              <button
                className="iconbtn ghost"
                onClick={() => setShowDetails(false)}
                title="Tutup"
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="dv-body">
              {editing ? (
                <div className="dv-edit">
                  <label className="dv-field">
                    <span>Judul</span>
                    <input
                      autoFocus
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Judul item"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") save();
                      }}
                    />
                  </label>
                  <label className="dv-field">
                    <span>Jenis</span>
                    <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                      {(Object.keys(KINDS) as Kind[]).map((k) => (
                        <option key={k} value={k}>
                          {KINDS[k].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="dv-field">
                    <span>Kategori (pisah dengan koma)</span>
                    <input
                      value={tagsText}
                      onChange={(e) => setTagsText(e.target.value)}
                      placeholder="mis. rpg, fantasy"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") save();
                      }}
                    />
                  </label>
                  {kind === "game" && (
                    <p className="dv-hint">
                      Untuk game, judul juga jadi pengelompok versi (mis. “Eternum 0.6” →
                      family “Eternum”). Tautan unduh tidak berubah.
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <div className="dv-title">
                    {item.version ? item.family : item.name}
                    {item.version && <span className="ver">{item.version}</span>}
                  </div>

                  <div className="dv-section">
                    <h4>Detail</h4>
                    <dl className="dv-meta">
                      <dt>Jenis</dt>
                      <dd>{meta.label}</dd>
                      <dt>Ukuran</dt>
                      <dd>{fmtSize(item.size)}</dd>
                      {item.parts > 1 && (
                        <>
                          <dt>{item.kind === "media" ? "Isi" : "Bagian"}</dt>
                          <dd>
                            {item.parts} {item.kind === "media" ? "file" : "part"}
                          </dd>
                        </>
                      )}
                      <dt>Ditambahkan</dt>
                      <dd>{fmtDate(item.added)}</dd>
                      {item.trashed && item.deletedAt != null && (
                        <>
                          <dt>Sampah</dt>
                          <dd>dihapus permanen dalam {trashDaysLeft(item.deletedAt)} hari</dd>
                        </>
                      )}
                    </dl>
                  </div>

                  {itemTags.length > 0 && (
                    <div className="dv-section">
                      <h4>Kategori</h4>
                      <div className="dv-tags">
                        {itemTags.map((t) => (
                          <span key={t.id} className="chip" style={{ ["--c" as string]: TAG_COLORS[t.color] }}>
                            <i></i>
                            {t.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer hanya untuk mode edit; tindakan lain pindah ke bar atas. */}
            {editing && (
              <div className="dv-actions">
                <button className="btn primary" onClick={save} disabled={!title.trim()}>
                  <Icon name="check" size={16} />
                  Simpan
                </button>
                <button className="btn" onClick={() => setEditing(false)}>
                  <Icon name="close" size={16} />
                  Batal
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
