# Deployment

**Bahasa:** Indonesia · [English](./DEPLOYMENT.md)

Deployment produksi memakai Docker Compose di VPS Linux. `setup.sh` menyiapkan Docker, `.env`, login Telethon, schema PostgreSQL, lalu menjalankan `docker compose up -d --build`.

## Perintah Utama

```bash
bash setup.sh
docker compose up -d --build
docker compose ps
docker compose logs -f bot
```

CD otomatis berjalan saat push ke `main`: GitHub Actions melakukan pull di VPS dan rebuild Compose.

## Rahasia

Jangan commit `.env`, session Telethon, log, atau credential. Pastikan `BOT_TOKEN`, channel ID, owner ID, kredensial API Telegram, password PostgreSQL, dan `DATABASE_URL` terisi.

Detail volume, profile `cloud`/`tunnel`, Windows, backup, dan troubleshooting ada di [versi English](./DEPLOYMENT.md).
