# OpenList — multi-drive gateway for Chinese cloud storage

rclone has no native backend for Baidu Netdisk / Quark / 115. **OpenList** mounts those drives and
re-exposes every one of them over **WebDAV**, which rclone *does* speak natively. So the whole
existing PikPak download pipeline is reused unchanged — only the rclone remote and path prefix
differ. One WebDAV remote (`openlist:`) fronts every drive; adding a drive is a UI + one-line
config change, no code.

```
/baidu <path>  →  rclone copy  →  openlist:  (webdav)  →  OpenList container  →  Baidu Netdisk
                       │                                        └── Quark / 115 (add later, config only)
                       ▼
                 staging → watcher → Telegram channel  (split into parts if > 2 GB, non-media)
```

> **Security — read this.** Use ONLY the community fork **OpenList** (`OpenListTeam/OpenList`,
> image `openlistteam/openlist`). Do **NOT** use anything named AList, any `alistgo.com` domain,
> the `alist.nn.ci` API, or AList Docker images — the original AList project was sold in 2025 and
> its prebuilt packages/APIs are considered compromised by the community.

The `openlist` service already lives in the repo's top-level `docker-compose.yml` (it must share the
Docker network so the bot's rclone can reach it in-network at `http://openlist:5244/dav`). Its admin
UI port is published on `127.0.0.1:5244` only — **never** bind it to `0.0.0.0`. Reach the UI over an
SSH tunnel or the existing Cloudflare Tunnel.

---

## 1. Start OpenList

It comes up with the rest of the stack:

```bash
docker compose up -d openlist
docker compose logs openlist        # watch first-boot output
```

Persistent data (config + saved drive credentials) lives in the `openlist-data` volume; a rebuild
does not lose it. Re-authentication after a cookie expiry is manual (see Limitations).

## 2. Get the admin password (first run)

OpenList generates a random admin password on first boot. Retrieve or reset it:

```bash
# Show it from the boot logs (first start only):
docker compose logs openlist | grep -i -A1 password

# Or set a fresh one explicitly (works any time):
docker compose exec openlist ./openlist admin set 'YOUR_STRONG_PASSWORD'
```

Do **not** hardcode this password anywhere in the repo.

## 3. Open the admin UI (no public exposure)

From your workstation, tunnel the localhost-only port over SSH:

```bash
ssh -i <key.pem> -L 5244:127.0.0.1:5244 ec2-user@<vps-ip>
# then browse http://localhost:5244  → log in as `admin` + the password from step 2
```

## 4. Add Baidu Netdisk as a storage

In the UI: **Manage → Storages → Add**.

- **Driver:** `Baidu Netdisk`
- **Mount path:** `/baidu`  ← this is the WebDAV prefix; it must match the registry entry
  (`DRIVES_JSON` → `baidu.prefix = "baidu"`, i.e. mount path `/baidu`).
- **Auth:** paste the account **cookie** (or `BDUSS`) as the driver requires. Get it by logging into
  `pan.baidu.com` in a browser and copying the cookie from DevTools → Application → Cookies.
  Refresh token / client id/secret fields can be left at driver defaults for a cookie login.
- Save, then confirm the storage shows **work** (green) in the storages list.

Never commit or paste the cookie/BDUSS into the repo or compose files — it lives only in the
OpenList data volume.

## 5. Verify WebDAV

WebDAV is enabled by default in OpenList and serves the whole mounted tree under `/dav`. The bot's
rclone uses the admin credentials. Quick check from the host:

```bash
curl -u admin:'YOUR_PASSWORD' http://127.0.0.1:5244/dav/baidu/   # should list your Baidu root
```

If you prefer a dedicated WebDAV account, create one under **Manage → Users** (read permission on
`/baidu` is enough) and use it in the rclone remote below instead of `admin`.

## 6. Add the rclone `openlist` remote (on the VPS host)

rclone config lives on the **host** at `~/.config/rclone/rclone.conf` (bind-mounted into the bot
container — see `docker-compose.yml`). Add the WebDAV remote there, same as the existing `pikpak`
remote:

```bash
rclone config
#   n) new remote
#   name> openlist
#   Storage> webdav
#   url> http://openlist:5244/dav        ← in-network name the bot container resolves
#   vendor> other
#   user> admin                          ← or the dedicated WebDAV user from step 5
#   pass> (enter the OpenList password)
#   (leave the rest blank / defaults)
```

The `url` uses the compose service name `openlist`, not `127.0.0.1`, because the bot's rclone runs
inside the bot container on the shared network. If you run rclone **from the host** to test, use
`http://127.0.0.1:5244/dav` instead, or add a second remote for host testing.

Verify:

```bash
docker compose exec bot rclone lsd openlist:baidu     # list Baidu top-level folders
docker compose exec bot rclone lsf openlist:baidu     # list entries
```

Then in Telegram: `/baidu_ls` to browse, `/baidu <path>` to download.

## 7. Add a future drive (Quark, 115, Tianyi, …) — config only, no code

1. OpenList UI → **Add storage** → pick the driver → set mount path `/quark` (etc.) → paste auth.
2. Add one entry to `DRIVES_JSON` in `.env` and restart the bot:

   ```json
   {"quark": {"remote": "openlist", "prefix": "quark", "folder": "quark", "display": "Quark"}}
   ```

3. Register the two 1-line handlers in `bot/bot.py` (`/quark`, `/quark_ls`) mirroring `/baidu`.

   (The download pipeline, size policy, and splitting are all generic — nothing else changes.)

---

## Limitations

- **Cookie expiry.** Baidu/Quark logins are cookie/token based and expire. When they do, downloads
  fail with an auth error and the bot tells you to re-authenticate — do it in the OpenList UI
  (steps 3–4), not in the bot.
- **Baidu throttling.** Non-SVIP Baidu accounts are throttled hard; multi-GB downloads can be very
  slow. rclone is configured with low-level retries and generous timeouts to ride this out rather
  than fail fast — expect long transfers, not errors.
- **Reverse-engineered drivers.** OpenList's Chinese-drive drivers track undocumented web APIs and
  can break when a provider changes theirs; a driver fix means updating the `openlistteam/openlist`
  image.
- **Large non-media files are split.** Files > 2 GB that aren't streamable media are uploaded as
  sequential binary parts (`name.001`, `name.002`, …), one logical item with N parts. Download all
  parts in order and reassemble with a plain concatenation:

  ```bash
  cat name.001 name.002 name.003 > name        # Linux/macOS
  copy /b name.001+name.002+name.003 name       # Windows
  ```

  Media files > 2 GB are **rejected** instead (a binary-split video can't be streamed or played).
