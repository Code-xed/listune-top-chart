"""
ChartSpot Telegram plugin: inline mode + normal /spotify menu.

Normal mode:
  /spotify
  /spotify india
  /spotify global weekly

Creates a stitched album-artwork collage with Pillow, sends it as a photo,
and attaches inline buttons for period, region, pagination, refresh, and Spotify.

Inline mode:
  @YourBot sp
  @YourBot sp india
  @YourBot sp global daily

Expected plugin manager contract:
  name, version, prefixes, async inline(query, context), handlers = [...]

Dependencies:
  python-telegram-bot (already used by the bot)
  Pillow (install with: pip install Pillow)

API:
  https://chartspot.netlify.app
"""

from __future__ import annotations

import asyncio
import html
import io
import json
import os
import time
import urllib.parse
import urllib.request
from typing import Any

from PIL import Image, ImageDraw, ImageFont
from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InlineQueryResultArticle,
    InlineQueryResultPhoto,
    InputMediaPhoto,
    InputTextMessageContent,
    Update,
)
from telegram.constants import ParseMode
from telegram.ext import CallbackQueryHandler, CommandHandler, ContextTypes

name = "ChartSpot"
version = "2.0.0"
prefixes = ["sp", "spotify"]

API_BASE = os.getenv("CHARTSPOT_API_BASE", "https://chartspot.netlify.app").rstrip("/")
CACHE_TTL = max(30, int(os.getenv("CHARTSPOT_CACHE_TTL", "600")))
REQUEST_TIMEOUT = max(3, int(os.getenv("CHARTSPOT_TIMEOUT", "12")))
PAGE_SIZE = 8
COLLAGE_TRACKS = 6

COUNTRIES = {
    "global": ("🌍", "Global"),
    "in": ("🇮🇳", "India"),
    "us": ("🇺🇸", "United States"),
    "gb": ("🇬🇧", "United Kingdom"),
    "jp": ("🇯🇵", "Japan"),
    "kr": ("🇰🇷", "South Korea"),
    "id": ("🇮🇩", "Indonesia"),
    "au": ("🇦🇺", "Australia"),
    "ca": ("🇨🇦", "Canada"),
    "br": ("🇧🇷", "Brazil"),
    "de": ("🇩🇪", "Germany"),
    "fr": ("🇫🇷", "France"),
    "mx": ("🇲🇽", "Mexico"),
    "nl": ("🇳🇱", "Netherlands"),
    "es": ("🇪🇸", "Spain"),
    "it": ("🇮🇹", "Italy"),
    "ph": ("🇵🇭", "Philippines"),
    "se": ("🇸🇪", "Sweden"),
    "tr": ("🇹🇷", "Turkey"),
    "ar": ("🇦🇷", "Argentina"),
    "my": ("🇲🇾", "Malaysia"),
}

PERIODS = {
    "daily": "📅 Daily",
    "weekly": "📆 Weekly",
    "monthly": "🗓 Monthly",
    "yearly": "🏆 Yearly",
}

ALIASES = {
    "india": "in", "us": "us", "usa": "us", "america": "us",
    "uk": "gb", "britain": "gb", "global": "global", "world": "global",
    "japan": "jp", "korea": "kr", "indonesia": "id", "australia": "au",
    "canada": "ca", "brazil": "br", "germany": "de", "france": "fr",
    "mexico": "mx", "netherlands": "nl", "spain": "es", "italy": "it",
    "philippines": "ph", "sweden": "se", "turkey": "tr", "argentina": "ar",
    "malaysia": "my",
}

_CACHE: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}


def _fetch_json_sync(url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "ChartSpot-TelegramPlugin/2.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
        data = json.loads(response.read().decode("utf-8", "replace"))
    if not isinstance(data, dict):
        raise ValueError("ChartSpot returned an unexpected response.")
    if data.get("error"):
        raise RuntimeError(str(data["error"]))
    return data


async def fetch_chart(country: str, period: str, force: bool = False) -> dict[str, Any]:
    country = country if country in COUNTRIES else "global"
    period = period if period in PERIODS else "daily"
    key = (country, period)
    now = time.monotonic()
    cached = _CACHE.get(key)
    if not force and cached and now - cached[0] < CACHE_TTL:
        return cached[1]

    url = f"{API_BASE}/api/stats/tracks?{urllib.parse.urlencode({'country': country, 'limit': 200, 'period': period})}"
    data = await asyncio.to_thread(_fetch_json_sync, url)
    tracks = data.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError("ChartSpot response has no tracks array.")
    data["tracks"] = [t for t in tracks if isinstance(t, dict)]
    data.setdefault("period", "daily")
    data.setdefault("country", country)
    _CACHE[key] = (now, data)
    return data


def _parse_args(raw: str) -> tuple[str, str]:
    parts = (raw or "").strip().split()
    if parts and parts[0].lower() in prefixes:
        parts = parts[1:]
    country, period = "global", "daily"
    for part in parts:
        token = part.lower().strip(",")
        if token in ALIASES:
            country = ALIASES[token]
        elif token in COUNTRIES:
            country = token
        elif token in PERIODS:
            period = token
    return country, period


def _esc(value: Any) -> str:
    return html.escape(str(value or "Unknown"), quote=False)


def _compact(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    if number >= 1_000_000_000:
        return f"{number / 1_000_000_000:.2f}B"
    if number >= 1_000_000:
        return f"{number / 1_000_000:.2f}M"
    if number >= 1_000:
        return f"{number / 1_000:.1f}K"
    return f"{int(number):,}"


def _country_label(country: str) -> str:
    flag, label = COUNTRIES.get(country, COUNTRIES["global"])
    return f"{flag} {label}"


def _track_line(track: dict[str, Any]) -> str:
    rank = track.get("rank", "?")
    title = _esc(track.get("name") or track.get("trackName"))
    artist = _esc(track.get("mainArtistName") or track.get("artistName"))
    streams = _compact(track.get("dailyStreams"))
    return f"<b>{rank}. {title}</b>\n   {artist} · <b>{streams}</b> streams"


def _caption(data: dict[str, Any], country: str, period: str, page: int) -> str:
    tracks = data.get("tracks", [])
    selected = tracks[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]
    lines = [
        f"🎵 <b>CHARTSPOT</b> · {_esc(_country_label(country))}",
        f"<b>{_esc(PERIODS.get(period, '📅 Daily'))} leaderboard</b>",
        "",
    ]
    if selected:
        for track in selected:
            entry = _track_line(track)
            if len("\n\n".join(lines + [entry])) > 850:
                break
            lines.extend([entry, ""])
    else:
        lines.append("No tracks available on this page.")

    lines.extend(["", "<i>Stream counts sourced from ChartSpot/Kworb.</i>"])
    result = "\n".join(lines).strip()
    return result[:1000]


def _keyboard(country: str, period: str, page: int, count: int, top_track: dict[str, Any] | None) -> InlineKeyboardMarkup:
    rows = [
        [
            InlineKeyboardButton(("✓ " if period == "daily" else "") + "📅 Daily", callback_data=f"spc|{country}|daily|0"),
            InlineKeyboardButton(("✓ " if period == "weekly" else "") + "📆 Weekly", callback_data=f"spc|{country}|weekly|0"),
        ],
        [
            InlineKeyboardButton(("✓ " if period == "monthly" else "") + "🗓 Monthly", callback_data=f"spc|{country}|monthly|0"),
            InlineKeyboardButton(("✓ " if period == "yearly" else "") + "🏆 Yearly", callback_data=f"spc|{country}|yearly|0"),
        ],
        [
            InlineKeyboardButton(("✓ " if country == "global" else "") + "🌍 Global", callback_data=f"spc|global|{period}|0"),
            InlineKeyboardButton(("✓ " if country == "in" else "") + "🇮🇳 India", callback_data=f"spc|in|{period}|0"),
            InlineKeyboardButton(("✓ " if country == "us" else "") + "🇺🇸 US", callback_data=f"spc|us|{period}|0"),
        ],
        [
            InlineKeyboardButton(("✓ " if country == "gb" else "") + "🇬🇧 UK", callback_data=f"spc|gb|{period}|0"),
            InlineKeyboardButton("🌐 More regions", callback_data=f"spc|regions|{period}|0"),
        ],
    ]
    pages = max(1, (count + PAGE_SIZE - 1) // PAGE_SIZE)
    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton("⬅️ Previous", callback_data=f"spc|{country}|{period}|{page-1}"))
    nav.append(InlineKeyboardButton(f"{min(page + 1, pages)}/{pages}", callback_data="spc|noop|daily|0"))
    if page + 1 < pages:
        nav.append(InlineKeyboardButton("Next ➡️", callback_data=f"spc|{country}|{period}|{page+1}"))
    rows.append(nav)
    if top_track:
        url = top_track.get("spotifyUrl")
        track_id = top_track.get("trackId")
        if not url and track_id:
            url = f"https://open.spotify.com/track/{track_id}"
        if url:
            rows.append([InlineKeyboardButton("🎧 Open top track on Spotify", url=str(url))])
    rows.append([InlineKeyboardButton("🔄 Refresh", callback_data=f"spc|{country}|{period}|{page}|refresh")])
    return InlineKeyboardMarkup(rows)


def _font(size: int, bold: bool = False):
    candidates = (
        ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"]
        if bold else
        ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"]
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _download_image_sync(url: str) -> Image.Image | None:
    if not isinstance(url, str) or not url.startswith("https://"):
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ChartSpot/2.0"})
        with urllib.request.urlopen(req, timeout=5) as response:
            raw = response.read(2_000_000)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        image.thumbnail((360, 360))
        return image
    except Exception:
        return None


async def _download_image(url: str) -> Image.Image | None:
    return await asyncio.to_thread(_download_image_sync, url)


async def make_collage(data: dict[str, Any], country: str, period: str, page: int) -> bytes:
    """Create a poster-like collage using album artworks from the visible page."""
    tracks = data.get("tracks", [])
    start = page * PAGE_SIZE
    visible = tracks[start:start + PAGE_SIZE]
    artwork_tracks = [t for t in visible if t.get("imageUrl")][:COLLAGE_TRACKS]

    # 900x900 poster, three columns by two rows of cover art.
    canvas = Image.new("RGB", (900, 900), (18, 18, 18))
    draw = ImageDraw.Draw(canvas)
    title_font = _font(36, True)
    subtitle_font = _font(24, True)
    small_font = _font(19, False)

    draw.text((34, 24), "CHARTSPOT", font=title_font, fill=(255, 255, 255))
    draw.text((36, 76), f"{_country_label(country)}  •  {period.upper()} CHART", font=subtitle_font, fill=(190, 220, 190))

    tile = 270
    gap = 12
    left = 34
    top = 128
    positions = [
        (left, top), (left + tile + gap, top), (left + 2 * (tile + gap), top),
        (left, top + tile + gap), (left + tile + gap, top + tile + gap),
        (left + 2 * (tile + gap), top + tile + gap),
    ]

    images = await asyncio.gather(*[
        _download_image(str(track.get("imageUrl", ""))) for track in artwork_tracks
    ])

    for idx, (track, image) in enumerate(zip(artwork_tracks, images)):
        x, y = positions[idx]
        if image:
            image = image.resize((tile, tile), Image.Resampling.LANCZOS)
            canvas.paste(image, (x, y))
        else:
            draw.rectangle((x, y, x + tile, y + tile), fill=(42, 42, 42))
            draw.text((x + 18, y + 100), "Artwork unavailable", font=small_font, fill=(230, 230, 230))
        # translucent overlay for rank/title readability
        overlay = Image.new("RGBA", (tile, 78), (0, 0, 0, 175))
        canvas.paste(overlay, (x, y + tile - 78), overlay)
        label = f"#{track.get('rank', idx + 1)}  {_compact(track.get('dailyStreams'))} streams"
        draw.text((x + 10, y + tile - 68), label[:31], font=small_font, fill=(255, 255, 255))
        track_name = str(track.get("name") or track.get("trackName") or "Unknown track")
        draw.text((x + 10, y + tile - 38), track_name[:25], font=small_font, fill=(210, 210, 210))

    if not artwork_tracks:
        draw.rectangle((34, 128, 866, 692), fill=(35, 35, 35))
        draw.text((65, 350), "No album artwork available", font=subtitle_font, fill=(255, 255, 255))

    # Compact leaderboard strip along the bottom.
    draw.text((35, 720), "TOP TRACKS", font=subtitle_font, fill=(255, 255, 255))
    y = 758
    for track in visible[:5]:
        line = f"{track.get('rank', '?')}. {track.get('name') or track.get('trackName')} — {track.get('mainArtistName') or track.get('artistName')}"
        draw.text((38, y), line[:76], font=small_font, fill=(225, 225, 225))
        y += 25
    output = io.BytesIO()
    canvas.save(output, format="JPEG", quality=88, optimize=True)
    return output.getvalue()


async def _send_chart(chat_or_message, context, country: str, period: str, page: int = 0, force: bool = False, edit_message=None):
    data = await fetch_chart(country, period, force=force)
    actual_period = str(data.get("period", "daily")).lower()
    if actual_period != period:
        notice = (
            f"{PERIODS.get(period, period)} isn't available from the current ChartSpot API yet. "
            "The backend currently returns daily charts."
        )
        if edit_message:
            await edit_message.reply_text(notice)
        else:
            await chat_or_message.reply_text(notice)
        return

    tracks = data["tracks"]
    max_page = max(0, (len(tracks) - 1) // PAGE_SIZE)
    page = max(0, min(page, max_page))
    selected = tracks[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]
    top_track = selected[0] if selected else (tracks[0] if tracks else None)
    caption = _caption(data, country, period, page)
    keyboard = _keyboard(country, period, page, len(tracks), top_track)
    image_bytes = await make_collage(data, country, period, page)

    if edit_message:
        # Editing a photo message preserves the interactive menu.
        try:
            await edit_message.edit_media(
                media=InputMediaPhoto(media=image_bytes, caption=caption, parse_mode=ParseMode.HTML),
                reply_markup=keyboard,
            )
        except Exception:
            await edit_message.reply_photo(
                photo=image_bytes, caption=caption, parse_mode=ParseMode.HTML, reply_markup=keyboard
            )
    else:
        await chat_or_message.reply_photo(
            photo=image_bytes,
            caption=caption,
            parse_mode=ParseMode.HTML,
            reply_markup=keyboard,
        )


async def spotify_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Normal chat mode: /spotify [country] [period]."""
    message = update.effective_message
    if not message:
        return
    raw = " ".join(context.args or [])
    country, period = _parse_args(raw)
    try:
        await message.reply_text("🎵 Fetching ChartSpot charts…")
        await _send_chart(message, context, country, period)
    except Exception as exc:
        await message.reply_text(
            f"⚠️ Couldn't load ChartSpot right now.\n<code>{_esc(str(exc)[:300])}</code>",
            parse_mode=ParseMode.HTML,
        )


async def inline(query, context):
    """Inline mode entry point for the existing plugin manager."""
    country, period = _parse_args(getattr(query, "query", ""))
    try:
        data = await fetch_chart(country, period)
        actual_period = str(data.get("period", "daily")).lower()
        if actual_period != period:
            result = InlineQueryResultArticle(
                id=f"chartspot-unavailable-{period}",
                title=f"⚠️ {PERIODS.get(period, period)} chart not available yet",
                description="The current API returns daily charts.",
                input_message_content=InputTextMessageContent(
                    message_text=(
                        f"🎵 <b>ChartSpot</b>\n\n{_esc(PERIODS.get(period, period))} charts "
                        "aren't exposed by the current API yet. Daily charts are available."
                    ),
                    parse_mode=ParseMode.HTML,
                ),
            )
            await query.answer([result], cache_time=10, is_personal=True)
            return

        tracks = data.get("tracks", [])
        caption = _caption(data, country, period, 0)
        keyboard = _keyboard(country, period, 0, len(tracks), tracks[0] if tracks else None)
        photo = next((t.get("imageUrl") for t in tracks if t.get("imageUrl")), None)

        if photo and isinstance(photo, str) and photo.startswith("https://"):
            result = InlineQueryResultPhoto(
                id=f"chartspot-{country}-{period}",
                photo_url=photo,
                thumbnail_url=photo,
                title=f"{_country_label(country)} {period} Spotify chart",
                description=f"Top {len(tracks)} tracks · Interactive leaderboard",
                caption=caption,
                parse_mode=ParseMode.HTML,
                reply_markup=keyboard,
            )
        else:
            result = InlineQueryResultArticle(
                id=f"chartspot-{country}-{period}",
                title=f"🎵 ChartSpot · {_country_label(country)}",
                description=f"{period.title()} Spotify leaderboard",
                input_message_content=InputTextMessageContent(
                    message_text=caption,
                    parse_mode=ParseMode.HTML,
                    disable_web_page_preview=True,
                ),
                reply_markup=keyboard,
            )
        await query.answer([result], cache_time=10, is_personal=True)
    except Exception as exc:
        result = InlineQueryResultArticle(
            id="chartspot-error",
            title="⚠️ ChartSpot could not load charts",
            description=str(exc)[:160],
            input_message_content=InputTextMessageContent(
                message_text="🎵 <b>ChartSpot</b>\n\nCouldn't fetch the chart right now. Please try again.",
                parse_mode=ParseMode.HTML,
            ),
        )
        await query.answer([result], cache_time=3, is_personal=True)


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if not query or not query.data:
        return
    parts = query.data.split("|")
    if len(parts) < 4 or parts[0] != "spc":
        return
    _, country, period, page_raw, *extra = parts

    if country == "noop":
        await query.answer()
        return
    if country == "regions":
        await query.answer("Available shortcuts: Global, India, US, UK, Japan, Korea, Brazil and more.", show_alert=True)
        return
    if country not in COUNTRIES:
        country = "global"
    if period not in PERIODS:
        period = "daily"
    try:
        page = max(0, int(page_raw))
    except ValueError:
        page = 0
    force = bool(extra and extra[0] == "refresh")

    try:
        await query.answer("Refreshing…" if force else None)
        if not query.message:
            return
        await _send_chart(
            query.message,
            context,
            country,
            period,
            page=page,
            force=force,
            edit_message=query.message,
        )
    except Exception as exc:
        try:
            await query.answer(f"ChartSpot error: {str(exc)[:150]}", show_alert=True)
        except Exception:
            pass


handlers = [
    CommandHandler("spotify", spotify_command),
    CommandHandler("charts", spotify_command),
    CallbackQueryHandler(handle_callback, pattern=r"^spc\|"),
]
