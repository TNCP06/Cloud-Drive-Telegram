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

    # 7. Comment link: ?comment= targets one message in the post's discussion group
    links = tg_import.parse_tg_links("https://t.me/gsxjjf/1648?comment=39725")
    assert len(links) == 1
    assert links[0]["target_chat"] == "gsxjjf"
    assert links[0]["target_msg_id"] == 1648
    assert links[0]["comment_id"] == 39725
    assert links[0]["raw_link"] == "https://t.me/gsxjjf/1648?comment=39725"

    # 8. Comment link with extra params (?single) and legacy ?thread= form
    links = tg_import.parse_tg_links("https://t.me/gsxjjf/1648?comment=39725&single")
    assert links[0]["comment_id"] == 39725
    links = tg_import.parse_tg_links("https://t.me/c/1234567890/42?thread=77")
    assert links[0]["target_msg_id"] == 42 and links[0]["comment_id"] == 77

    # 9. Plain query (?single only) → post itself, no comment target
    links = tg_import.parse_tg_links("https://t.me/gsxjjf/1648?single")
    assert links[0]["comment_id"] is None

    # 10. Range link with a comment query → comment is dropped (single-message semantics)
    links = tg_import.parse_tg_links("https://t.me/gsxjjf/100-102?comment=39725")
    assert len(links) == 3
    assert all(l["comment_id"] is None for l in links)


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

    # Comment link alone must NOT leak its query string into the custom title
    links, title, tags = tg_import.parse_import_command("/import https://t.me/gsxjjf/1648?comment=39725")
    assert len(links) == 1
    assert links[0]["comment_id"] == 39725
    assert title is None and tags is None

    # Comment link with a real custom title still parses the title cleanly
    links, title, tags = tg_import.parse_import_command("/import https://t.me/gsxjjf/1648?comment=39725 My Title | v")
    assert links[0]["comment_id"] == 39725
    assert title == "My Title" and tags == "v"


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


def test_inspect_message_meta():
    import asyncio

    class DummyFile:
        def __init__(self, name, size):
            self.name = name
            self.size = size

    class DummyMsg:
        def __init__(self, mid, message, fname, size):
            self.id = mid
            self.media = True
            self.message = message
            self.file = DummyFile(fname, size)
            self.grouped_id = None

    class DummyClient:
        async def get_entity(self, chat):
            return chat
        async def get_messages(self, entity, ids):
            if ids == 42:
                return DummyMsg(42, "#action #movie Awesome Show Ep 01", "show_01.mp4", 104857600)
            return None

    client = DummyClient()
    res = asyncio.run(tg_import.inspect_message_meta(client, "-1001234567890", 42))
    assert res["ok"] is True
    assert res["title"] == "Awesome Show Ep 01"
    assert res["tags"] == "action, movie"
    assert res["filename"] == "show_01.mp4"
    assert res["size"] == 104857600
    assert res["num_files"] == 1


def test_comment_target_resolution():
    import asyncio

    class DummyFile:
        def __init__(self, name, size):
            self.name = name
            self.size = size

    class DummyMsg:
        def __init__(self, mid, message, fname, size):
            self.id = mid
            self.media = True
            self.message = message
            self.file = DummyFile(fname, size)
            self.grouped_id = None

    class DummyChat:
        def __init__(self, cid):
            self.id = cid

    class DummyFull:
        class full_chat:
            linked_chat_id = 555
        chats = [DummyChat(111), DummyChat(555)]

    class DummyClient:
        def __init__(self):
            self.requests = []

        async def get_entity(self, chat):
            return chat

        async def __call__(self, request):
            self.requests.append(type(request).__name__)
            return DummyFull()

        async def get_messages(self, entity, ids):
            # The comment message lives in the linked discussion group, not the channel.
            if ids == 39725 and getattr(entity, "id", None) == 555:
                return DummyMsg(39725, "resource video comment", "resource.mp4", 2048)
            return None

    client = DummyClient()
    res = asyncio.run(tg_import.inspect_message_meta(client, "gsxjjf", 1648, comment_id=39725))
    assert res["ok"] is True
    assert res["filename"] == "resource.mp4"
    assert res["size"] == 2048
    assert client.requests == ["GetFullChannelRequest"]

    # Comment on a channel with no linked discussion group → user-facing error.
    class NoLinkFull:
        class full_chat:
            linked_chat_id = None
        chats = []

    class NoLinkClient(DummyClient):
        async def __call__(self, request):
            return NoLinkFull()

    res = asyncio.run(tg_import.inspect_message_meta(NoLinkClient(), "gsxjjf", 1648, comment_id=39725))
    assert res["ok"] is False
    assert "diskusi" in res["error"]


if __name__ == "__main__":
    test_parse_tg_links()
    test_parse_import_command()
    test_formatters()
    test_derive_title_tags()
    test_inspect_message_meta()
    test_comment_target_resolution()
    print("All tg_import tests passed!")
