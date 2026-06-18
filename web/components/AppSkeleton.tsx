import { Icon } from "@/lib/icons";

// Skeleton shell saat data drive di-fetch dari Turso (Suspense loading.tsx).
export function AppSkeleton() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="cloud" size={17} stroke={1.7} />
          </div>
          <div>
            <div className="brand-name">Vault</div>
            <div className="brand-sub">Telegram Drive</div>
          </div>
        </div>
        <div className="side-scroll">
          <div className="nav-group">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skel" style={{ height: 34, margin: "6px 4px", borderRadius: 7 }} />
            ))}
          </div>
          <div className="nav-group">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skel" style={{ height: 28, margin: "6px 4px" }} />
            ))}
          </div>
        </div>
        <div className="Tags">
          <div className="skel" style={{ height: 64 }} />
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="skel" style={{ height: 26, width: 150 }} />
          <div className="spacer" />
          <div className="skel" style={{ height: 34, width: 240, borderRadius: 99 }} />
          <div className="skel hide-mob" style={{ height: 34, width: 70, borderRadius: 7 }} />
        </div>
        <div className="toolbar">
          <div className="skel" style={{ height: 24, width: 130 }} />
        </div>
        <div className="content">
          <div className="grid">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="card">
                <div className="thumb skel" style={{ height: 104 }} />
                <div className="skel" style={{ height: 13, marginTop: 12, width: "82%" }} />
                <div className="skel" style={{ height: 11, marginTop: 8, width: "55%" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
