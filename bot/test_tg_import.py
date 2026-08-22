"""Standalone unit tests for bot/tg_import.py link parsing & formatting logic.

Run:
    python bot/test_tg_import.py
"""

import os
import sys
import types

# Minimal env so bot_config imports safely
os.environ.setdefault("BOT_TOKEN", "test_token")
os.environ.setdefault("STORAGE_CHANNEL_ID", "-1000000000000")
os.environ.setdefault("OWNER_USER_ID", "1")
os.environ.setdefault("DATABASE_URL", "postgresql://u:p@localhost/db")

# Stub psycopg_pool so import chain works without database
if "psycopg_pool" not in sys.modules:
    m = types.ModuleType("psycopg_pool")
    m.AsyncConnectionPool = object
    sys.modules["psycopg_pool"] = m

import tg_import


def test_parse_tg_links():
    # 1. Private channel standard link
    links = tg_import.parse_tg_links("https://t.me/c/1234567890/42")
    assert len(links) == 1
    assert links[0]["target_chat"] == "-1001234567890"
    assert links[0]["target_msg_id"] == 42

    # 2. Private channel topic/thread link
    links = tg_import.parse_tg_links("https://t.me/c/1234567890/10/42")
    assert len(links) == 1
    assert links[0]["target_chat"] == "-1001234567890"
    assert links[0]["target_msg_id"] == 42

    # 3. Public channel link
    links = tg_import.parse_tg_links("https://t.me/cool_channel/99")
    assert len(links) == 1
    assert links[0]["target_chat"] == "cool_channel"
    assert links[0]["target_msg_id"] == 99

    # 4. Short form t.me without https
    links = tg_import.parse_tg_links("t.me/c/987654321/100")
    assert len(links) == 1
    assert links[0]["target_chat"] == "-100987654321"
    assert links[0]["target_msg_id"] == 100

    # 5. Range link (e.g. 100-103)
    links = tg_import.parse_tg_links("https://t.me/c/1234567890/100-103")
    assert len(links) == 4
    assert [l["target_msg_id"] for l in links] == [100, 101, 102, 103]
    assert all(l["target_chat"] == "-1001234567890" for l in links)

    # 6. Multiple links in one text
    text = "Here are two videos: https://t.me/c/111/10 and https://t.me/public/20"
    links = tg_import.parse_tg_links(text)
    assert len(links) == 2
    assert links[0]["target_chat"] == "-100111" and links[0]["target_msg_id"] == 10
    assert links[1]["target_chat"] == "public" and links[1]["target_msg_id"] == 20


def test_parse_import_command():
    # Basic command
    links, title, tags = tg_import.parse_import_command("/import https://t.me/c/1234567890/42")
    assert len(links) == 1
    assert links[0]["target_msg_id"] == 42
    assert title is None
    assert tags is None

    # Command with Title and Tags
    links, title, tags = tg_import.parse_import_command("/import https://t.me/c/1234567890/42 Episode 1 | anime, 1080p")
    assert len(links) == 1
    assert links[0]["target_msg_id"] == 42
    assert title == "Episode 1"
    assert tags == "anime, 1080p"

    # Command with /save alias and Title only
    links, title, tags = tg_import.parse_import_command("/save https://t.me/channel/55 Tutorial Video")
    assert len(links) == 1
    assert links[0]["target_chat"] == "channel"
    assert links[0]["target_msg_id"] == 55
    assert title == "Tutorial Video"
    assert tags is None


def test_formatters():
    assert tg_import.human_size(0) == "0 B"
    assert tg_import.human_size(500) == "500 B"
    assert tg_import.human_size(1048576) == "1.00 MB"
    assert tg_import.human_size(2 * 1024 ** 3) == "2.00 GB"

    assert tg_import._fmt_eta(30) == "30s"
    assert tg_import._fmt_eta(90) == "1m 30s"
    assert tg_import._fmt_eta(3665) == "1h 1m"


def test_derive_title_tags():
    # Contract caption → title + contract tags
    t, g = tg_import._derive_title_tags("My Video | 1/2 | anime, hd", None, None)
    assert t == "My Video" and g == "anime, hd"

    # Custom title kept; contract tags still derived (forward parity)
    t, g = tg_import._derive_title_tags("My Video | 1/2 | anime", "Custom", None)
    assert t == "Custom" and g == "anime"

    # Custom title AND tags win over the caption entirely
    t, g = tg_import._derive_title_tags("My Video | 1/2 | anime", "Custom", "x, y")
    assert t == "Custom" and g == "x, y"

    # Free-form caption → hashtags become tags, first line (sans hashtags) becomes title
    t, g = tg_import._derive_title_tags("#anime New release ep 1 #hd", None, None)
    assert t == "New release ep 1"
    assert g == "anime, hd"

    # Free-form caption with custom title → only hashtags fill the empty tags
    t, g = tg_import._derive_title_tags("#anime something long\nsecond line", "T", None)
    assert t == "T" and g == "anime"

    # No caption at all → empty defaults (caller falls back to filename/date)
    t, g = tg_import._derive_title_tags("", None, None)
    assert t == "" and g == ""


if __name__ == "__main__":
    test_parse_tg_links()
    test_parse_import_command()
    test_formatters()
    test_derive_title_tags()
    print("All tg_import tests passed!")
