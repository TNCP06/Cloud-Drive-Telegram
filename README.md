# Telegram Cloud Drive ☁️🚀

A personal, unlimited cloud storage and media catalog system built on top of Telegram's infrastructure. It utilizes Telegram Private Channels for pure file storage (bypassing traditional server storage limits) and Turso (libSQL) as the highly available metadata brain.

## 🌟 Key Features

- **Infinite Storage via Telegram**: Files are natively stored as messages/documents in a Telegram Private Channel. No hosting costs for raw data.
- **Smart Indexing Bot**: A dedicated Python Telegram Bot automatically listens to the channel, parses captions, generates metadata, and stores it in the database.
- **Bot Drop (Web Upload)**: Upload large media or documents directly to the bot via PM. The Bot securely holds the file while you fill out metadata on the Web Dashboard, completely bypassing Vercel's upload limits.
- **Multi-device Dashboard**: A Next.js front-end deployed on Vercel allows you to browse, search, edit metadata, and delete files from your phone or PC without opening the Telegram app.
- **Zero-Laptop Downloading**: Clicking "Download" on the web dashboard triggers the bot to seamlessly forward the file to your personal Telegram chat via the `copyMessage` API, offering full download speeds without hitting server bottlenecks.
- **Large Game & Multi-part Support**: Dedicated worker scripts for PC to split and upload multi-GB games/archives using MTProto (Telethon), auto-assembled on the web UI.

## 🏗️ Architecture

For an in-depth look at how the data flows between the Web Dashboard, Turso, and Telegram, please read the [Architecture Document](./arsitektur-telegram-storage.md).

### Tech Stack
- **Web Dashboard**: Next.js 14, React, Tailwind CSS
- **Database**: Turso (libSQL / SQLite compatible edge database)
- **Indexer Bot & Worker**: Python 3.11, python-telegram-bot (PTB), Telethon
- **Deployment**: Vercel (Web), Server/VPS (Bot)

## 🚀 Quick Start & Setup

### 1. Database (Turso)
Create a new libSQL database on Turso and execute the `schema.sql` located in the `bot/` directory.

### 2. Telegram Setup
- Create a Private Channel (this will be your storage).
- Create a Bot via [@BotFather](https://t.me/BotFather) and get the `BOT_TOKEN`.
- Add your Bot to the Private Channel as an **Admin** with posting & editing rights.
- Get the Channel ID (usually starts with `-100`).

### 3. Environment Variables
Create `.env.local` for the Web and `.env` for the Bot using the provided `.example` files. You will need your Telegram User ID, the Channel ID, Turso Database URL, and Turso Auth Token.

### 4. Running the Bot
```bash
cd bot
pip install -r requirements.txt
python bot.py
```

### 5. Running the Web Dashboard
```bash
cd web
npm install
npm run dev
```

## 📄 License
MIT License. Created for personal use.
