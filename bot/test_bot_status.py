import asyncio
import os
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from telegram.error import NetworkError

sys.path.insert(0, os.path.dirname(__file__))

if "psycopg_pool" not in sys.modules:
    pool = types.ModuleType("psycopg_pool")
    pool.AsyncConnectionPool = object
    sys.modules["psycopg_pool"] = pool

from bot import _edit_upload_status  # noqa: E402


class UploadStatusTest(unittest.IsolatedAsyncioTestCase):
    async def test_retries_transient_bot_api_disconnect(self):
        bot = SimpleNamespace(edit_message_text=AsyncMock(
            side_effect=[NetworkError("disconnected"), NetworkError("restarting"), "ok"]))

        with patch.object(asyncio, "sleep", new=AsyncMock()) as sleep:
            result = await _edit_upload_status(SimpleNamespace(bot=bot), 1, 2, "status")

        self.assertEqual(result, "ok")
        self.assertEqual(bot.edit_message_text.await_count, 3)
        self.assertEqual(sleep.await_count, 2)


if __name__ == "__main__":
    unittest.main()
