# Shared image for bot.py and watcher.py (compose picks the command per service).
# ffmpeg → media thumbnails; p7zip-full → the legacy 'local' archive split (the new
# browser-upload path needs neither, it raw-splits in pure Python).
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg p7zip-full \
 && rm -rf /var/lib/apt/lists/*

COPY bot/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY bot/ ./

ENV PYTHONUNBUFFERED=1 \
    SEVENZIP_PATH=7z

# Default; docker-compose overrides this for the watcher service.
CMD ["python", "-u", "bot.py"]
