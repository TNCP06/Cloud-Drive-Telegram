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
import re
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


# All supported languages in CapCut Web Auto captions mapped to UI match pattern and 2-letter ISO code
CAPCUT_LANGUAGE_MAP: dict[str, dict] = {
    "id": {"name": "Indonesian", "pattern": r"Indonesian|Bahasa Indonesia", "iso": "id"},
    "en": {"name": "English (US)", "pattern": r"English \(US\)|English", "iso": "en"},
    "ja": {"name": "Japanese", "pattern": r"Japanese|日本語", "iso": "ja"},
    "ko": {"name": "Korean", "pattern": r"Korean|한국어", "iso": "ko"},
    "zh": {"name": "Chinese", "pattern": r"Chinese|中文|Mandarin", "iso": "zh"},
    "es": {"name": "Spanish", "pattern": r"Spanish|Español", "iso": "es"},
    "pt": {"name": "Portuguese", "pattern": r"Portuguese|Português", "iso": "pt"},
    "fr": {"name": "French", "pattern": r"French|Français", "iso": "fr"},
    "de": {"name": "German", "pattern": r"German|Deutsch", "iso": "de"},
    "vi": {"name": "Vietnamese", "pattern": r"Vietnamese|Tiếng Việt", "iso": "vi"},
    "th": {"name": "Thai", "pattern": r"Thai|ไทย", "iso": "th"},
    "it": {"name": "Italian", "pattern": r"Italian|Italiano", "iso": "it"},
    "ar": {"name": "Arabic", "pattern": r"Arabic|العربية", "iso": "ar"},
    "ru": {"name": "Russian", "pattern": r"Russian|Русский", "iso": "ru"},
    "tr": {"name": "Turkish", "pattern": r"Turkish|Türkçe", "iso": "tr"},
    "ms": {"name": "Malay", "pattern": r"Malay|Bahasa Melayu", "iso": "ms"},
    "tl": {"name": "Filipino", "pattern": r"Filipino|Tagalog", "iso": "tl"},
    "hi": {"name": "Hindi", "pattern": r"Hindi", "iso": "hi"},
    "nl": {"name": "Dutch", "pattern": r"Dutch|Nederlands", "iso": "nl"},
    "pl": {"name": "Polish", "pattern": r"Polish|Polski", "iso": "pl"},
    "ro": {"name": "Romanian", "pattern": r"Romanian|Română", "iso": "ro"},
}


def resolve_capcut_language(lang: str | None) -> dict | None:
    """Resolve an ISO code or Whisper language name to CapCut configuration dict."""
    if not lang:
        return None
    key = lang.strip().lower()
    if key in CAPCUT_LANGUAGE_MAP:
        return CAPCUT_LANGUAGE_MAP[key]
    for info in CAPCUT_LANGUAGE_MAP.values():
        if re.search(info["pattern"], key, re.IGNORECASE) or key == info["name"].lower():
            return info
    return None


def capcut_lang_iso(language: str | None) -> str:
    """Map human language name or ISO code to 2-letter ISO code."""
    info = resolve_capcut_language(language)
    if info:
        return info["iso"]
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


def _select_capcut_language(page, language: str) -> bool:
    """Select the target spoken language in CapCut's Auto captions panel."""
    lang_info = resolve_capcut_language(language)
    target_name = lang_info["name"] if lang_info else language
    pattern = lang_info["pattern"] if lang_info else re.escape(language)
    log.info("CapCut: setting transcription language to '%s' …", target_name)

    try:
        # 1. Check if the target language is already selected on the sidebar above Generate button
        already_selected = page.evaluate("""(pat) => {
            const re = new RegExp(pat, 'i');
            const gen = Array.from(document.querySelectorAll('button')).find(b => b.innerText && b.innerText.includes('Generate') && !b.innerText.includes('Generated'));
            if (!gen) return false;
            const genTop = gen.getBoundingClientRect().top;
            const els = Array.from(document.querySelectorAll('span, div, button, p')).filter(el => {
                const r = el.getBoundingClientRect();
                return r.left >= 0 && r.right <= 450 && r.top >= genTop - 200 && r.bottom <= genTop;
            });
            return els.some(el => re.test(el.innerText || ''));
        }""", pattern)

        if already_selected:
            log.info("CapCut: language '%s' is already active in UI", target_name)
            return True

        # 2. Click the language dropdown trigger above the Generate button
        opened = page.evaluate("""() => {
            const gen = Array.from(document.querySelectorAll('button')).find(b => b.innerText && b.innerText.includes('Generate') && !b.innerText.includes('Generated'));
            if (!gen) return false;
            const genTop = gen.getBoundingClientRect().top;
            const langNames = ['English', 'Indonesian', 'Bahasa', 'Japanese', 'Korean', 'Chinese', 'Spanish', 'Portuguese', 'French', 'German', 'Vietnamese', 'Thai', 'Italian', 'Arabic', 'Russian', 'Malay', 'Filipino', 'Hindi', 'Dutch', 'Turkish', 'Polish', 'Romanian'];
            const els = Array.from(document.querySelectorAll('div, button, span')).filter(el => {
                const r = el.getBoundingClientRect();
                return r.left >= 0 && r.right <= 450 && r.top >= genTop - 200 && r.bottom <= genTop && r.height >= 20 && r.width >= 40;
            });
            for (const el of els) {
                const txt = el.innerText || '';
                if (langNames.some(l => txt.includes(l)) || (el.className && el.className.includes('select')) || el.getAttribute('aria-haspopup')) {
                    el.click();
                    return true;
                }
            }
            return false;
        }""")

        if not opened:
            for el in page.locator("[class*='select'], [class*='dropdown'], button").all():
                box = el.bounding_box()
                if box and box["y"] < 400 and box["x"] < 450 and box["height"] >= 20:
                    el.click(force=True)
                    opened = True
                    break

        time.sleep(1.5)

        # 3. Locate target language in the dropdown menu list and click it
        lang_items = page.locator(f"text=/{pattern}/i").all()
        target_el = None
        for item in lang_items:
            try:
                if item.is_visible():
                    target_el = item
                    break
            except Exception:
                pass
        if not target_el and lang_items:
            target_el = lang_items[-1]

        if target_el:
            target_el.scroll_into_view_if_needed()
            time.sleep(0.5)
            target_el.click(force=True)
            log.info("CapCut: successfully selected language '%s'", target_name)
            time.sleep(1.0)
            return True
        else:
            log.warning("CapCut: language option for '%s' not visible in dropdown list", target_name)
            return False
    except Exception as e:
        log.debug("CapCut: language selection error (%s), using default", e)
        return False


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
        _select_capcut_language(page, language)

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
