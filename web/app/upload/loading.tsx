export default function Loading() {
  return (
    <div className="up-wrap">
      <div className="up-inner">
        <div className="up-head">
          <div className="skel" style={{ height: 30, width: 220 }} />
        </div>
        <div className="skel" style={{ height: 72, marginBottom: 22, borderRadius: 10 }} />
        <div className="skel" style={{ height: 280, borderRadius: 14, marginBottom: 28 }} />
        <div style={{ display: "grid", placeItems: "center", padding: 30 }}>
          <div className="spinner" />
        </div>
      </div>
    </div>
  );
}
