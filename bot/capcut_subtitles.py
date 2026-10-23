"""CapCut Web AutoCaption integration for background subtitle generation.

Extracts speech to subtitles (.srt / WebVTT segments) using CapCut Web's ASR engine,
which is particularly strong for Indonesian colloquial speech, slang, and music lyrics.
Integrates into stream_subtitles.py as a configurable primary STT provider with
automatic failover to Groq Whisper.
"""

from __future__ import annotations

import asyncio
import glob
import json
import logging
import os
import sys
import time
from pathlib import Path

log = logging.getLogger("streamer")

CAPCUT_PRIMARY = os.environ.get("CAPCUT_PRIMARY", "1") not in ("0", "false", "False", "")
CAPCUT_COOKIE_FILE = os.environ.get("CAPCUT_COOKIE_FILE", "").strip()
CAPCUT_COOKIES_DIR = os.environ.get("CAPCUT_COOKIES_DIR", "cookies").strip()
CAPCUT_LANG = os.environ.get("CAPCUT_LANG", "Indonesian").strip()
CAPCUT_TIMEOUT_S = int(os.environ.get("CAPCUT_TIMEOUT_S", "180"))
CAPCUT_HEADLESS = os.environ.get("CAPCUT_HEADLESS", "1") not in ("0", "false", "False", "")


def capcut_lang_iso(language: str | None) -> str:
    """Map human language name or ISO code to 2-letter ISO code."""
    if not language:
        return "id"
    l = language.strip().lower()
    if "indo" in l:
        return "id"
    if "eng" in l:
        return "en"
    if "japan" in l:
        return "ja"
    if "korean" in l:
        return "ko"
    if "chin" in l or "mandarin" in l:
        return "zh"
    if "span" in l:
        return "es"
    if "french" in l:
        return "fr"
    if "ger" in l:
        return "de"
    if "malay" in l:
        return "ms"
    if "arab" in l:
        return "ar"
    if "viet" in l:
        return "vi"
    if "thai" in l:
        return "th"
    if len(l) == 2:
        return l
    return "id"


def normalize_cookies(cookie_input: str | list | dict) -> list[dict]:
    """Normalize exported browser cookies (Cookie-Editor format) for Playwright."""
    if isinstance(cookie_input, str):
        if not os.path.exists(cookie_input):
            return []
        with open(cookie_input, "r", encoding="utf-8") as f:
            raw_cookies = json.load(f)
    elif isinstance(cookie_input, list):
        raw_cookies = cookie_input
    elif isinstance(cookie_input, dict):
        raw_cookies = [cookie_input]
    else:
        return []

    norm = []
    for c in raw_cookies:
        if not isinstance(c, dict) or "name" not in c or "value" not in c:
            continue
        domain = c.get("domain", "")
        cookie = {
            "name": c["name"],
            "value": c["value"],
            "domain": domain,
            "path": c.get("path", "/"),
            "secure": c.get("secure", False),
            "httpOnly": c.get("httpOnly", False),
        }
        ss = str(c.get("sameSite", "")).lower()
        if ss in ["lax", "strict", "none"]:
            cookie["sameSite"] = ss.capitalize()
        elif ss == "no_restriction":
            cookie["sameSite"] = "None"
        else:
            cookie["sameSite"] = "Lax"

        if "expirationDate" in c and c["expirationDate"]:
            try:
                cookie["expires"] = int(c["expirationDate"])
            except (ValueError, TypeError):
                pass
        norm.append(cookie)
    return norm


def parse_cookies_txt(txt_path: str) -> list[dict]:
    """Read cookie source list from cookies.txt."""
    sources = []
    if not os.path.exists(txt_path):
        return sources

    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
    except Exception:
        return sources

    base_dir = os.path.dirname(os.path.abspath(txt_path))
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        for cp in [line, os.path.join(base_dir, line)]:
            if os.path.isfile(cp):
                sources.append({"type": "file", "path": os.path.abspath(cp), "name": os.path.basename(cp)})
                break
    return sources


def discover_cookie_sources(custom_cookie: str | None = None) -> list[dict]:
    """Discover available CapCut cookie files in prioritized order."""
    sources: list[dict] = []
    seen: set[str] = set()

    def add(item: dict) -> None:
        key = item.get("path") or item.get("name")
        if key and key not in seen:
            seen.add(key)
            sources.append(item)

    # 1. Custom cookie file from environment / parameter
    target = custom_cookie or CAPCUT_COOKIE_FILE
    if target:
        p = os.path.abspath(target)
        if os.path.isfile(p):
            add({"type": "file", "path": p, "name": os.path.basename(p)})
        elif os.path.isdir(p):
            for f in sorted(glob.glob(os.path.join(p, "*.json"))):
                add({"type": "file", "path": os.path.abspath(f), "name": os.path.basename(f)})

    # 2. cookies.txt file
    for candidate_txt in ["cookies.txt", "cookies/cookies.txt", "/app/cookies.txt"]:
        if os.path.exists(candidate_txt):
            for s in parse_cookies_txt(candidate_txt):
                add(s)

    # 3. cookies directory
    for cdir in [CAPCUT_COOKIES_DIR, "cookies", "/app/cookies"]:
        if os.path.isdir(cdir):
            for f in sorted(glob.glob(os.path.join(cdir, "*.json"))):
                add({"type": "file", "path": os.path.abspath(f), "name": os.path.basename(f)})

    # 4. Root / current directory fallback
    for pat in ["profile_switcher_*.json", "capcut_cookie*.json"]:
        for f in sorted(glob.glob(pat)):
            add({"type": "file", "path": os.path.abspath(f), "name": os.path.basename(f)})

    return sources


def capcut_available() -> bool:
    """Return True if Playwright is installed and at least one CapCut cookie source exists."""
    if not CAPCUT_PRIMARY:
        return False
    try:
        import playwright  # noqa: F401
    except ImportError:
        return False
    return len(discover_cookie_sources()) > 0


def _dismiss_popups(page) -> None:
    """Dismiss guide overlays, promotional banners, and modal dialogs."""
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    try:
        page.evaluate("""() => {
            // Click close / skip buttons
            document.querySelectorAll('[class*="close" i], [aria-label*="close" i], button:has-text("Skip")').forEach(el => {
                try { el.click(); } catch(e) {}
            });
            // Remove lingering modal/guide/tooltip/mask/dialog elements
            const sels = [
                '[class*="guide"]', '[class*="tooltip"]', '[class*="popover"]',
                '[class*="drawer"]', '[class*="tour"]', '[class*="modal"]',
                '[class*="mask"]', '[class*="dialog"]', '[class*="popup"]',
                '[class*="banner"]', '[class*="overlay"]'
            ];
            document.querySelectorAll(sels.join(', ')).forEach(el => el.remove());
        }""")
    except Exception:
        pass


def _cleanup_capcut_library(page) -> None:
    """Delete the newly created project draft from CapCut cloud storage to keep quota clean."""
    try:
        page.goto("https://www.capcut.com/library?enter_from=page_header&from_page=work_space",
                  wait_until="domcontentloaded", timeout=25000)
        time.sleep(3)
        _dismiss_popups(page)

        card = page.locator("[class*='itemSelectAble']").first
        if card.count() == 0:
            return

        card.hover()
        time.sleep(1)
        action_btn = card.locator("[class*='actions-']").first
        if action_btn.count() > 0:
            action_btn.click(force=True)
            time.sleep(1)
            trash_btn = page.locator("text='Move to Trash'").last
            if trash_btn.count() > 0:
                trash_btn.click(force=True)
                time.sleep(1.5)
                confirm_btn = page.locator("button:has-text('Confirm'), button:has-text('Move to Trash')").last
                if confirm_btn.count() > 0:
                    confirm_btn.click(force=True)
                    time.sleep(2)
        log.info("CapCut: project draft cleaned up from cloud storage")
    except Exception as e:
        log.debug("CapCut: library cleanup skipped (%s)", e)


def _transcribe_single_account(page, video_abs_path: str, language: str, timeout: int,
                              captured_utterances: list[dict]) -> bool:
    """Execute the full browser automation flow for a single CapCut session."""
    log.info("CapCut: opening Web Editor …")
    page.goto("https://www.capcut.com/editor?scenario=custom", wait_until="domcontentloaded", timeout=45000)
    time.sleep(4)

    # Check for login redirect
    curr_url = page.url
    if any(k in curr_url for k in ["/login", "/sign-in", "passport"]):
        log.warning("CapCut: cookies expired or session redirected to login")
        return False

    _dismiss_popups(page)

    # Upload video file
    video_input = page.locator("input[type='file'][accept*='mp4'], input[type='file']").first
    try:
        video_input.wait_for(state="attached", timeout=20000)
    except Exception:
        log.warning("CapCut: video input element not found in DOM")
        return False

    log.info("CapCut: uploading video %s …", os.path.basename(video_abs_path))
    video_input.set_input_files(video_abs_path)
    time.sleep(8)
    _dismiss_popups(page)

    # Open Captions tab on sidebar
    caption_tab = page.get_by_text("Captions", exact=True).first
    if caption_tab.count() == 0:
        caption_tab = page.locator(".workbench-menu-item-title:has-text('Captions'), .siderMenuCaption-menu").first

    if caption_tab.count() > 0:
        try:
            caption_tab.click(force=True, timeout=5000)
        except Exception:
            page.evaluate("""() => {
                const spans = Array.from(document.querySelectorAll('span, div, p, li'));
                const cap = spans.find(s => s.innerText && s.innerText.trim() === 'Captions');
                if (cap) (cap.closest('li') || cap.closest('button') || cap.parentElement || cap).click();
            }""")
    else:
        page.evaluate("""() => {
            const spans = Array.from(document.querySelectorAll('span, div, p, li'));
            const cap = spans.find(s => s.innerText && s.innerText.trim() === 'Captions');
            if (cap) (cap.closest('li') || cap.closest('button') || cap.parentElement || cap).click();
        }""")

    time.sleep(3)
    _dismiss_popups(page)

    # Select Auto captions card
    auto_card = page.locator("text=/Auto captions/i").first
    if auto_card.count() > 0:
        try:
            auto_card.wait_for(timeout=8000)
            auto_card.click(force=True)
        except Exception:
            page.evaluate("""() => {
                const els = Array.from(document.querySelectorAll('div, span, p, h3, h4'));
                const ac = els.find(e => e.innerText && e.innerText.includes('Auto captions'));
                if (ac) (ac.closest('[class*="card"]') || ac.closest('div') || ac).click();
            }""")
    else:
        page.evaluate("""() => {
            const els = Array.from(document.querySelectorAll('div, span, p, h3, h4'));
            const ac = els.find(e => e.innerText && e.innerText.includes('Auto captions'));
            if (ac) (ac.closest('[class*="card"]') || ac.closest('div') || ac).click();
        }""")

    time.sleep(2)
    _dismiss_popups(page)

    # Select language if specified
    if language:
        try:
            all_en = page.locator("text='English (US)'").all()
            for el in all_en:
                box = el.bounding_box()
                if box and box["y"] < 350 and box["x"] < 500:
                    el.click(force=True)
                    time.sleep(1.5)
                    break

            lang_item = page.locator(f"text=/{language}/i").last
            if lang_item.count() > 0:
                lang_item.scroll_into_view_if_needed()
                time.sleep(0.5)
                lang_item.click(force=True)
                log.info("CapCut: selected language '%s'", language)
        except Exception as e:
            log.debug("CapCut: language selection error (%s), using default", e)

    time.sleep(2)
    _dismiss_popups(page)

    # Click Generate button
    gen_btn = page.locator("button").filter(has_text="Generate").filter(has_not_text="Generated").first
    if gen_btn.count() == 0:
        gen_btn = page.get_by_role("button", name="Generate", exact=True).first

    if gen_btn.count() > 0:
        gen_btn.click(force=True, no_wait_after=True)
    else:
        page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const gen = btns.find(b => b.innerText && b.innerText.includes('Generate') && !b.innerText.includes('Generated'));
            if (gen) gen.click();
        }""")
    log.info("CapCut: clicked Generate — awaiting API transcription (timeout %ds) …", timeout)

    # Poll for captured API utterances
    start_time = time.time()
    while time.time() - start_time < timeout:
        time.sleep(1)
        if captured_utterances:
            break

    # Clean up project draft from cloud storage
    _cleanup_capcut_library(page)

    return len(captured_utterances) > 0


def _transcribe_with_capcut_sync(video_path: str, language: str = "Indonesian",
                                 timeout: int = 180) -> list[dict] | None:
    """Synchronous runner for Playwright CapCut extraction."""
    from playwright.sync_api import sync_playwright

    video_abs_path = os.path.abspath(video_path)
    if not os.path.exists(video_abs_path):
        log.warning("CapCut: video file not found at %s", video_abs_path)
        return None

    sources = discover_cookie_sources()
    if not sources:
        log.info("CapCut: no cookie files available — skipping")
        return None

    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--start-maximized",
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=CAPCUT_HEADLESS, args=launch_args)
        try:
            for idx, cs in enumerate(sources, 1):
                captured_utterances: list[dict] = []

                def on_response(res):
                    u = res.url
                    if "caption/query" in u:
                        try:
                            ct = res.headers.get("content-type", "")
                            if "application/json" in ct:
                                body = res.json()
                                caps = body.get("data", {}).get("caption", [])
                                for c in caps:
                                    utts = c.get("utterances", [])
                                    if utts and len(utts) > len(captured_utterances):
                                        captured_utterances.clear()
                                        captured_utterances.extend(utts)
                                        break
                        except Exception:
                            pass

                context_kwargs = {
                    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                }
                if CAPCUT_HEADLESS:
                    context_kwargs["viewport"] = {"width": 1920, "height": 1080}
                else:
                    context_kwargs["no_viewport"] = True

                context = browser.new_context(**context_kwargs)
                try:
                    norm_cookies = normalize_cookies(cs["path"])
                    if not norm_cookies:
                        continue
                    context.add_cookies(norm_cookies)
                    page = context.new_page()
                    page.on("response", on_response)

                    success = _transcribe_single_account(
                        page=page,
                        video_abs_path=video_abs_path,
                        language=language,
                        timeout=timeout,
                        captured_utterances=captured_utterances,
                    )

                    if success and captured_utterances:
                        # Convert utterances to standard segment format {start: float, end: float, text: str}
                        segments = []
                        for u in captured_utterances:
                            start_s = round(float(u.get("start_time", 0)) / 1000.0, 3)
                            end_s = round(float(u.get("end_time", 0)) / 1000.0, 3)
                            text = (u.get("text") or "").strip()
                            if text:
                                segments.append({"start": start_s, "end": end_s, "text": text})

                        log.info("CapCut: successfully extracted %d subtitle segments using cookie %s",
                                 len(segments), cs["name"])
                        return segments
                    else:
                        log.warning("CapCut: account %s did not produce subtitles", cs["name"])
                except Exception as ex:
                    log.warning("CapCut: error with cookie %s: %s", cs["name"], ex)
                finally:
                    try:
                        context.close()
                    except Exception:
                        pass
        finally:
            try:
                browser.close()
            except Exception:
                pass

    return None


async def transcribe_with_capcut(video_path: str, language: str = "Indonesian",
                                timeout: int = 180) -> list[dict] | None:
    """Asynchronously transcribe a video file using CapCut Web in a background thread."""
    if not capcut_available():
        return None
    return await asyncio.to_thread(_transcribe_with_capcut_sync, video_path, language, timeout)
