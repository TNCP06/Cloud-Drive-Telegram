# Documentation

Team-style reference for **Telegram Cloud Drive**. These docs describe the system as it is
**actually implemented** (kept next to the code, read on demand — not loaded automatically).

| Doc | Read it when you need… |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The mental model: components, data flow, the caption contract, identity/idempotency invariants, auth, tech stack. |
| [BUSINESS-FLOWS.md](./BUSINESS-FLOWS.md) | Step-by-step for every operation (upload game/media, Bot Drop, download, delete/restore/purge, tags, watcher), with "needs laptop?" and the code path. |
| [CODE-MAP.md](./CODE-MAP.md) | Where a function lives and what it does — file-by-file across `bot/` and `web/`. |

Related (older / non-authoritative):
- [`../arsitektur-telegram-storage.md`](../arsitektur-telegram-storage.md) — original Indonesian design rationale.
- [`../README.md`](../README.md) — project intro & quick start.
- `web-cloud-drive-design/` — early UI mockup only (the live app has diverged).

> Keeping these current: when you change a flow or move a function, update the matching doc in
> the same PR. They're plain Markdown with no build step.
