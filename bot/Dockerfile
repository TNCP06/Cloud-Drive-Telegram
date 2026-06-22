# Shared image for bot.py and watcher.py (compose picks the command per service).
# ffmpeg → media thumbnails; p7zip-full → the legacy 'local' archive split (the new
# browser-upload path needs neither, it raw-splits in pure Python).
FROM python:3.11-slim

WORKDIR /app

# ffmpeg → media thumbnails; p7zip-full → legacy 'local' archive split;
# postgresql-client-16 → pg_dump for the daily DB backup job (bot.py → Telegram). The
# client major must match the postgres:16 server, so pull it from the PGDG apt repo
# (Debian's default postgresql-client is 15 and would refuse to dump a v16 server).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg p7zip-full curl gnupg ca-certificates \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/*

COPY bot/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY bot/ ./

ENV PYTHONUNBUFFERED=1 \
    SEVENZIP_PATH=7z

# Default; docker-compose overrides this for the watcher service.
CMD ["python", "-u", "bot.py"]
