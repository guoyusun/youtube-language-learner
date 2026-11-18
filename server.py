#!/usr/bin/env python3
"""
YouTube Language Learner - Local Web App Server
Automatically fetches YouTube / YouTube Shorts subtitles for foreign language learning,
using word-level json3 timestamps and multi-pass linguistic sentence reconstruction
so complete and long sentences are never chopped into fragments.
"""

import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from youtube_transcript_api import YouTubeTranscriptApi

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CACHE_DIR = BASE_DIR / ".cache"
CACHE_DIR.mkdir(exist_ok=True)

# In-memory cache for fast repeated lookups
TRANSCRIPT_CACHE: Dict[str, Dict[str, Any]] = {}

# Abbreviations that end with a period but do NOT end a sentence
ABBREVIATIONS = {
    "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "mt.", "capt.",
    "col.", "gen.", "lt.", "sgt.", "corp.", "inc.", "ltd.", "co.", "vs.", "v.",
    "e.g.", "i.e.", "etc.", "al.", "fig.", "no.", "vol.", "rev.", "est.", "approx.",
    "u.s.", "u.k.", "e.u.", "a.i.", "ph.d.", "b.a.", "m.a.", "d.c.", "a.m.", "p.m.",
}

# Words that indicate a fragment is continuing the previous sentence rather than starting a new one
CONTINUATION_STARTERS = {
    "and", "or", "but", "nor", "yet", "so",
    "into", "onto", "to", "from", "with", "without", "by", "for", "of", "in", "on", "at",
    "about", "through", "between", "among", "during", "before", "after", "under", "over",
    "that", "which", "who", "whom", "whose", "where", "when",
    "because", "although", "though", "while", "whilst", "whereas", "unless", "until",
    "since", "whether", "as", "than", "like", "including", "such",
}

# Words at the end of a segment that strongly indicate the sentence is incomplete
INCOMPLETE_ENDINGS = {
    "a", "an", "the", "my", "your", "his", "her", "its", "our", "their", "this", "that", "these", "those",
    "and", "or", "but", "nor", "so", "yet", "both", "either", "neither",
    "to", "of", "in", "on", "at", "by", "for", "with", "from", "into", "onto", "about", "as", "like",
    "between", "through", "during", "before", "after", "without", "within", "against", "among",
    "is", "are", "was", "were", "be", "been", "being", "am",
    "have", "has", "had", "do", "does", "did",
    "will", "would", "shall", "should", "can", "could", "may", "might", "must",
    "that", "which", "who", "whom", "whose", "where", "when", "why", "how", "whether", "if", "because",
    "very", "more", "most", "less", "least", "too", "quite", "rather", "not", "no",
}

NOISE_TAG_RE = re.compile(r"\[(?:music|applause|laughter|sound|noise|inaudible|silence|cheering)\]|♪+", re.IGNORECASE)


def extract_video_id(url_or_id: str) -> Tuple[Optional[str], bool]:
    """
    Extract the 11-character YouTube video ID from any YouTube URL format
    (watch, shorts, embed, youtu.be, or raw 11-char ID).
    Returns (video_id, is_shorts).
    """
    raw = (url_or_id or "").strip()
    if not raw:
        return None, False

    is_shorts = "/shorts/" in raw.lower()

    if re.fullmatch(r"[A-Za-z0-9_-]{11}", raw):
        return raw, is_shorts

    patterns = [
        r"(?:youtube\.com/shorts/)([A-Za-z0-9_-]{11})",
        r"(?:youtube\.com/watch\?.*?v=)([A-Za-z0-9_-]{11})",
        r"(?:youtu\.be/)([A-Za-z0-9_-]{11})",
        r"(?:youtube\.com/embed/)([A-Za-z0-9_-]{11})",
        r"(?:youtube\.com/v/)([A-Za-z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, raw)
        if match:
            return match.group(1), is_shorts

    try:
        parsed = urllib.parse.urlparse(raw)
        qs = urllib.parse.parse_qs(parsed.query)
        if "v" in qs and qs["v"]:
            candidate = qs["v"][0]
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
                return candidate, is_shorts
    except Exception:
        pass

    return None, False


def fetch_video_metadata(video_id: str) -> Dict[str, str]:
    """Fetch video title and author using YouTube's public oEmbed endpoint."""
    oembed_url = (
        f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    )
    try:
        req = urllib.request.Request(
            oembed_url,
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return {
                "title": data.get("title", f"YouTube Video ({video_id})"),
                "author": data.get("author_name", "YouTube Creator"),
                "thumbnail_url": data.get(
                    "thumbnail_url", f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
                ),
            }
    except Exception:
        return {
            "title": f"YouTube Video ({video_id})",
            "author": "",
            "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        }


def clean_subtitle_text(text: str) -> str:
    """Clean HTML entities, noise tags ([music], etc.), and redundant spaces."""
    if not text:
        return ""
    unescaped = html.unescape(text)
    without_noise = NOISE_TAG_RE.sub(" ", unescaped)
    cleaned = re.sub(r"\s+", " ", without_noise).strip()
    return cleaned


def normalize_raw_segments(raw_segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Normalize raw line segments so each entry has index, start, duration, end, text.
    Clamps overlapping display durations common in YouTube captions.
    """
    normalized: List[Dict[str, Any]] = []
    for item in raw_segments:
        text = clean_subtitle_text(item.get("text", ""))
        if not text:
            continue
        start = round(float(item.get("start", 0.0)), 3)
        duration = round(float(item.get("duration", 2.0)), 3)
        normalized.append(
            {
                "start": start,
                "duration": duration,
                "end": round(start + duration, 3),
                "text": text,
            }
        )

    for i in range(len(normalized) - 1):
        curr = normalized[i]
        nxt = normalized[i + 1]
        if curr["end"] > nxt["start"] and nxt["start"] > curr["start"] + 0.15:
            curr["end"] = round(nxt["start"], 3)
            curr["duration"] = round(curr["end"] - curr["start"], 3)

    for idx, seg in enumerate(normalized):
        seg["index"] = idx

    return normalized


def parse_json3_events_to_tokens(sub_data: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Parse YouTube json3 timedtext payload into:
    1. raw_lines: Line-level segments (for 'raw' mode)
    2. word_tokens: Fine-grained word/phrase tokens with exact millisecond start/end timestamps
       (from event['tStartMs'] + seg['tOffsetMs']) for accurate sentence reconstruction!
    """
    events = sub_data.get("events", [])
    raw_lines: List[Dict[str, Any]] = []
    word_tokens: List[Dict[str, Any]] = []

    for event in events:
        segs = event.get("segs")
        if not segs:
            continue
        ev_start_ms = float(event.get("tStartMs", 0))
        ev_dur_ms = float(event.get("dDurationMs", 2000))
        ev_end_ms = ev_start_ms + ev_dur_ms

        line_parts = []
        for s in segs:
            raw_utf8 = s.get("utf8", "")
            if not raw_utf8 or raw_utf8 == "\n":
                continue
            cleaned_tok = clean_subtitle_text(raw_utf8)
            if not cleaned_tok:
                continue
            line_parts.append(cleaned_tok)

            offset_ms = float(s.get("tOffsetMs", 0))
            tok_start_sec = (ev_start_ms + offset_ms) / 1000.0
            tok_end_sec = ev_end_ms / 1000.0
            word_tokens.append(
                {
                    "text": cleaned_tok,
                    "start": round(tok_start_sec, 3),
                    "end": round(tok_end_sec, 3),
                }
            )

        if line_parts:
            line_text = clean_subtitle_text(" ".join(line_parts))
            if line_text:
                raw_lines.append(
                    {
                        "start": round(ev_start_ms / 1000.0, 3),
                        "duration": round(ev_dur_ms / 1000.0, 3),
                        "text": line_text,
                    }
                )

    # Tighten word_tokens end timestamps using the next token's start time
    for i in range(len(word_tokens) - 1):
        curr = word_tokens[i]
        nxt = word_tokens[i + 1]
        if nxt["start"] >= curr["start"]:
            # Each word ends when the next word starts (or at most +1.2s if there is a pause)
            curr["end"] = round(min(curr["end"], nxt["start"], curr["start"] + 1.2), 3)
            if curr["end"] <= curr["start"]:
                curr["end"] = round(curr["start"] + 0.25, 3)

    return normalize_raw_segments(raw_lines), word_tokens


def is_true_sentence_end(word: str, next_word: Optional[str] = None) -> bool:
    """
    Determine whether `word` ends with genuine sentence-ending punctuation
    (and is not an abbreviation like 'Dr.', 'U.S.', 'e.g.', or ellipsis '...').
    """
    w = word.strip()
    if not w:
        return False

    # Strip trailing quotes/brackets for checking
    stripped = w.rstrip("\"'”’)]}")
    if not stripped:
        return False

    # Ellipsis '...' is often used as a pause mid-sentence in YouTube captions
    if stripped.endswith("...") or stripped.endswith("…"):
        return False

    last_char = stripped[-1]
    if last_char not in ".?!。？！":
        return False

    # Question mark and exclamation mark are almost always sentence endings
    if last_char in "?!？！。":
        return True

    # It's a period '.': check for abbreviations, initials, or decimals
    lower_w = stripped.lower()
    if lower_w in ABBREVIATIONS:
        return False

    # Single capital initial like "J." or "R."
    if re.fullmatch(r"[A-Za-z]\.", stripped):
        return False

    # Multi-dotted acronym like "U.S.A." or "Ph.D."
    if re.fullmatch(r"(?:[A-Za-z]\.){2,}", stripped):
        return False

    # If the next word starts with a lowercase letter, this period was likely a false-positive or abbreviation
    if next_word:
        nw_clean = next_word.lstrip("\"'“‘([{")
        if nw_clean and nw_clean[0].islower():
            return False

    return True


def expand_multiword_tokens(tokens: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    If any token contains multiple space-separated words (e.g. from XML fallback or manual captions),
    split it into individual word tokens with proportionally interpolated timestamps so the
    word-level sentence builder works uniformly on both json3 and XML transcripts.
    """
    word_list: List[Dict[str, Any]] = []
    for tok in tokens:
        text = tok.get("text", "").strip()
        if not text:
            continue
        words = text.split()
        if len(words) == 1:
            word_list.append(
                {
                    "text": words[0],
                    "start": float(tok["start"]),
                    "end": float(tok["end"]),
                }
            )
        else:
            total_chars = max(1, sum(len(w) for w in words))
            start_t = float(tok["start"])
            end_t = float(tok["end"])
            total_dur = max(0.2, end_t - start_t)
            cur_t = start_t
            for i, w in enumerate(words):
                ratio = len(w) / total_chars
                w_dur = total_dur * ratio
                w_end = end_t if i == len(words) - 1 else round(cur_t + w_dur, 3)
                word_list.append(
                    {
                        "text": w,
                        "start": round(cur_t, 3),
                        "end": round(w_end, 3),
                    }
                )
                cur_t = w_end
    return word_list


def clean_first_last_word(text: str) -> Tuple[str, str]:
    """Return lowercase first word and last word stripped of punctuation."""
    words = text.strip().split()
    if not words:
        return "", ""
    first = re.sub(r"^[^\w]+|[^\w]+$", "", words[0]).lower()
    last = re.sub(r"^[^\w]+|[^\w]+$", "", words[-1]).lower()
    return first, last


def should_heal_continuation(prev_seg: Dict[str, Any], next_seg: Dict[str, Any]) -> bool:
    """
    Check if `prev_seg` and `next_seg` were artificially separated and actually belong
    to the same grammatical sentence.
    """
    prev_text = prev_seg["text"].strip()
    next_text = next_seg["text"].strip()
    if not prev_text or not next_text:
        return False

    gap = next_seg["start"] - prev_seg["end"]
    # Don't merge across a very long silence (> 2.2s)
    if gap > 2.2:
        return False

    combined_dur = next_seg["end"] - prev_seg["start"]
    if combined_dur > 28.0:
        return False

    _, prev_last_word = clean_first_last_word(prev_text)
    next_first_word, _ = clean_first_last_word(next_text)

    # 1. Previous segment doesn't end with terminal punctuation (. ? ! 。 ？ ！)
    prev_stripped = prev_text.rstrip("\"'”’)]}")
    if prev_stripped and prev_stripped[-1] not in ".?!。？！":
        return True

    # 2. Previous segment ends with a known incomplete word (preposition, conjunction, article, auxiliary)
    if prev_last_word in INCOMPLETE_ENDINGS:
        return True

    # 3. Next segment starts with a lowercase letter
    next_lstrip = next_text.lstrip("\"'“‘([{")
    if next_lstrip and next_lstrip[0].islower():
        return True

    # 4. Next segment starts with a subordinating/prepositional continuation word
    # e.g. "into a process we can control.", "because it...", "which means..."
    if next_first_word in {
        "into", "onto", "from", "with", "without", "by", "for", "of",
        "about", "through", "between", "among", "during", "before", "after",
        "that", "which", "who", "whom", "whose", "where", "when",
        "because", "although", "though", "while", "whilst", "whereas", "unless", "until",
        "whether", "than", "including",
    }:
        return True

    return False


def should_merge_short_partner(curr_seg: Dict[str, Any], next_seg: Dict[str, Any]) -> bool:
    """
    In 'sentence' (smart shadowing) mode, merge ultra-short rhetorical questions or
    short introductory/appositive fragments with their adjacent partner sentence so
    learners don't get 0.6s-1.5s micro-fragments.
    """
    curr_text = curr_seg["text"].strip()
    next_text = next_seg["text"].strip()
    if not curr_text or not next_text:
        return False

    gap = next_seg["start"] - curr_seg["end"]
    if gap > 1.2:
        return False

    curr_words = curr_text.split()
    next_words = next_text.split()
    curr_dur = curr_seg["end"] - curr_seg["start"]
    next_dur = next_seg["end"] - next_seg["start"]
    combined_dur = next_seg["end"] - curr_seg["start"]
    combined_words = len(curr_words) + len(next_words)

    # Never make a merged sentence overly long
    if combined_dur > 13.0 or combined_words > 34:
        return False

    next_first, _ = clean_first_last_word(next_text)
    next_is_question_or_header = (
        (next_text.endswith("?") and len(next_words) <= 6)
        or (next_first in {"what", "why", "how", "when", "where", "who", "which"} and len(next_words) <= 6)
        or next_text.lower().startswith(("and key", "key ", "step ", "part ", "number "))
    )

    # Case A: Current segment is a short rhetorical question -> merge forward with its answer!
    # e.g., "What is RSI?" + "R stands for recursive self-improvement."
    # e.g., "What it improves?" + "Code, reasoning, tools, workflows."
    # e.g., "Why it matters?" + "Faster innovation."
    # e.g., "How it works?" + "Evaluate, modify, test, and then repeat."
    if curr_text.endswith("?") and (len(curr_words) <= 6 or curr_dur <= 2.3):
        # Only merge if curr doesn't already contain a question + answer
        if curr_text.count("?") == 1 and not curr_text.endswith("."):
            return True

    # Case B: Current segment is an ultra-short introductory hook or topic label (<= 3 words or <= 1.5s)
    # e.g., "It's true." + "Even as an AI scientist..."
    # e.g., "And key risks." + "Loss control, misalignment..."
    if (len(curr_words) <= 3 or curr_dur <= 1.5) and not curr_text.endswith("?"):
        if not next_is_question_or_header:
            return True

    # Case C: Next segment is an ultra-short appositive / tail noun phrase (<= 3 words)
    # e.g., "So let's start with the first one." + "A single agent."
    # e.g., "AI that improves itself iteratively." + "AI building them."
    # Must NOT pull a question or new topic header backward!
    if (
        len(next_words) <= 3
        and not next_is_question_or_header
        and len(curr_words) <= 12
        and curr_dur <= 4.5
    ):
        return True

    # Case D: Two short quoted/parallel sentences (< 2.0s and <= 5 words each)
    # e.g., "My order never arrived." + "Can I get a refund?"
    # e.g., "AI building AI." + "AI building AI repeating."
    if (
        len(curr_words) <= 5
        and curr_dur <= 2.0
        and len(next_words) <= 5
        and next_dur <= 2.0
        and not (curr_text.endswith(".") and next_first in {"what", "why", "how", "when", "where"})
    ):
        return True

    return False


def build_smart_sentences(
    word_tokens: List[Dict[str, Any]], seg_mode: str = "sentence"
) -> List[Dict[str, Any]]:
    """
    Multi-pass linguistic sentence builder:
    - Pass 1: Assemble word tokens into complete sentences based on true sentence punctuation
      (no premature 9.5s or 140-char chopping!). For unpunctuated streams, only break at
      natural clause boundaries after >= 18s or >= 40 words.
    - Pass 2: Continuation healing — merge across false-positive periods where the next
      piece starts with a continuation word ('into', 'because', 'which', lowercase, etc.)
      or the previous piece ends with an incomplete word.
    - Pass 3 (when seg_mode == 'sentence'): Merge short rhetorical Q&A pairs and micro-fragments
      so every subtitle item is a natural, complete unit for listening & shadowing.
    """
    words = expand_multiword_tokens(word_tokens)
    if not words:
        return []

    # Pass 1: Word-stream assembly into base sentences
    pass1_sentences: List[Dict[str, Any]] = []
    buf_words: List[str] = []
    buf_start: float = 0.0
    buf_end: float = 0.0

    n_words = len(words)
    for i, w_tok in enumerate(words):
        w_text = w_tok["text"]
        next_w_text = words[i + 1]["text"] if i + 1 < n_words else None

        if not buf_words:
            buf_start = w_tok["start"]
            buf_end = w_tok["end"]
            buf_words = [w_text]
        else:
            # Check if there is a long silence gap (> 2.2s) AND buffer already has enough words
            gap = w_tok["start"] - buf_end
            if gap > 2.2 and len(buf_words) >= 5:
                pass1_sentences.append(
                    {
                        "start": round(buf_start, 3),
                        "end": round(buf_end, 3),
                        "duration": round(buf_end - buf_start, 3),
                        "text": " ".join(buf_words),
                    }
                )
                buf_start = w_tok["start"]
                buf_end = w_tok["end"]
                buf_words = [w_text]
            else:
                buf_end = max(buf_end, w_tok["end"])
                buf_words.append(w_text)

        cur_dur = buf_end - buf_start
        word_count = len(buf_words)

        # Check for true sentence end
        is_end = is_true_sentence_end(w_text, next_w_text)

        # Fallback for completely unpunctuated transcripts:
        # Only break if sentence exceeds 18 seconds or 42 words, and ONLY at a comma/clause boundary
        if not is_end and (cur_dur >= 18.0 or word_count >= 42):
            if w_text.endswith((",", ";", "—", "-")) or (
                next_w_text and next_w_text.lower() in {"and", "but", "so", "because", "which"}
            ):
                is_end = True
            elif cur_dur >= 26.0 or word_count >= 55:
                is_end = True

        if is_end:
            pass1_sentences.append(
                {
                    "start": round(buf_start, 3),
                    "end": round(buf_end, 3),
                    "duration": round(buf_end - buf_start, 3),
                    "text": " ".join(buf_words),
                }
            )
            buf_words = []

    if buf_words:
        pass1_sentences.append(
            {
                "start": round(buf_start, 3),
                "end": round(buf_end, 3),
                "duration": round(buf_end - buf_start, 3),
                "text": " ".join(buf_words),
            }
        )

    # Pass 2: Continuation Healing (merges clauses broken by false periods or mid-sentence splits)
    healed: List[Dict[str, Any]] = []
    for seg in pass1_sentences:
        if healed and should_heal_continuation(healed[-1], seg):
            prev = healed[-1]
            # If prev ended with an erroneous period before a continuation word like "into", strip the period
            next_first, _ = clean_first_last_word(seg["text"])
            if prev["text"].endswith(".") and (
                seg["text"][0].islower()
                or next_first in {"into", "onto", "from", "with", "by", "for", "of", "that", "which", "because", "to"}
            ):
                prev["text"] = prev["text"][:-1]
            prev["text"] = f"{prev['text']} {seg['text']}".strip()
            prev["end"] = round(seg["end"], 3)
            prev["duration"] = round(prev["end"] - prev["start"], 3)
        else:
            healed.append(dict(seg))

    if seg_mode == "clause":
        for idx, item in enumerate(healed):
            item["index"] = idx
        return healed

    # Pass 3 (seg_mode == 'sentence'): Smart Short-Sentence & Rhetorical Q&A Partner Merging
    merged: List[Dict[str, Any]] = []
    i = 0
    while i < len(healed):
        curr = dict(healed[i])
        while i + 1 < len(healed) and should_merge_short_partner(curr, healed[i + 1]):
            nxt = healed[i + 1]
            curr["text"] = f"{curr['text']} {nxt['text']}".strip()
            curr["end"] = round(nxt["end"], 3)
            curr["duration"] = round(curr["end"] - curr["start"], 3)
            i += 1
        merged.append(curr)
        i += 1

    # Final pass: if the very last segment or any isolated segment is still a tiny <= 3-word orphan,
    # attach it to the previous sentence if reasonable
    final_segments: List[Dict[str, Any]] = []
    for seg in merged:
        if (
            final_segments
            and (len(seg["text"].split()) <= 3 or seg["duration"] <= 1.4)
            and not seg["text"].endswith("?")
            and (seg["start"] - final_segments[-1]["end"] <= 1.0)
            and (seg["end"] - final_segments[-1]["start"] <= 15.0)
        ):
            prev = final_segments[-1]
            prev["text"] = f"{prev['text']} {seg['text']}".strip()
            prev["end"] = round(seg["end"], 3)
            prev["duration"] = round(prev["end"] - prev["start"], 3)
        else:
            final_segments.append(seg)

    for idx, item in enumerate(final_segments):
        item["index"] = idx

    return final_segments


def translate_segments_via_gtx(segments: List[Dict[str, Any]], target_lang: str) -> bool:
    """
    Translate subtitle segments into `target_lang` using Google's free GTX endpoint
    in batched chunks so every sentence gets a clean, aligned translation.
    """
    if not segments or not target_lang:
        return False

    tl = target_lang
    if tl in ("zh-Hans", "zh"):
        tl = "zh-CN"
    elif tl == "zh-Hant":
        tl = "zh-TW"

    try:
        batch_size = 20
        for start_idx in range(0, len(segments), batch_size):
            batch = segments[start_idx : start_idx + batch_size]
            joined_text = "\n".join(seg["text"].replace("\n", " ") for seg in batch)
            params = urllib.parse.urlencode(
                {
                    "client": "gtx",
                    "sl": "auto",
                    "tl": tl,
                    "dt": "t",
                    "q": joined_text,
                }
            )
            url = f"https://translate.googleapis.com/translate_a/single?{params}"
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            if data and isinstance(data[0], list):
                full_translated = "".join(chunk[0] for chunk in data[0] if chunk and chunk[0])
                trans_lines = [line.strip() for line in full_translated.split("\n")]
                for offset, seg in enumerate(batch):
                    if offset < len(trans_lines):
                        seg["translation"] = trans_lines[offset]
                    else:
                        seg["translation"] = ""
        return True
    except Exception as exc:
        print(f"[Warning] GTX translation fallback error: {exc}", file=sys.stderr)
        return False


def fetch_subtitles_via_ytdlp(
    video_id: str,
    preferred_lang: Optional[str] = None,
    translate_to: Optional[str] = None,
    seg_mode: str = "sentence",
) -> Dict[str, Any]:
    """Fallback subtitle extractor using yt-dlp (with json3 word timestamps)."""
    import yt_dlp

    url = f"https://www.youtube.com/watch?v={video_id}"
    ydl_opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    subtitles = info.get("subtitles") or {}
    auto_captions = info.get("automatic_captions") or {}

    available_tracks = []
    for lang_code in subtitles.keys():
        available_tracks.append(
            {
                "language_code": lang_code,
                "language": lang_code,
                "is_generated": False,
                "is_translatable": True,
            }
        )
    for lang_code in auto_captions.keys():
        if lang_code not in subtitles:
            available_tracks.append(
                {
                    "language_code": lang_code,
                    "language": f"{lang_code} (Auto)",
                    "is_generated": True,
                    "is_translatable": True,
                }
            )

    chosen_lang = preferred_lang
    chosen_formats = None
    is_generated = False

    if chosen_lang and chosen_lang in subtitles:
        chosen_formats = subtitles[chosen_lang]
    elif chosen_lang and chosen_lang in auto_captions:
        chosen_formats = auto_captions[chosen_lang]
        is_generated = True
    else:
        if subtitles:
            chosen_lang = next(iter(subtitles.keys()))
            chosen_formats = subtitles[chosen_lang]
        elif auto_captions:
            for candidate in ["en", "en-US", "ja", "ko", "es", "fr", "de", "zh-Hans"]:
                if candidate in auto_captions:
                    chosen_lang = candidate
                    chosen_formats = auto_captions[candidate]
                    is_generated = True
                    break
            if not chosen_formats:
                chosen_lang = next(iter(auto_captions.keys()))
                chosen_formats = auto_captions[chosen_lang]
                is_generated = True

    if not chosen_formats:
        raise ValueError("该视频没有任何可用的字幕或自动生成字幕轨道。")

    json3_url = None
    for fmt in chosen_formats:
        if fmt.get("ext") == "json3" and fmt.get("url"):
            json3_url = fmt["url"]
            break
    if not json3_url:
        json3_url = chosen_formats[0].get("url")

    req = urllib.request.Request(
        json3_url,
        headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        sub_data = json.loads(resp.read().decode("utf-8"))

    raw_lines, word_tokens = parse_json3_events_to_tokens(sub_data)
    if seg_mode == "raw":
        segments = raw_lines
    else:
        segments = build_smart_sentences(word_tokens, seg_mode=seg_mode)

    applied_translation = ""
    if translate_to and translate_to != chosen_lang:
        if translate_segments_via_gtx(segments, translate_to):
            applied_translation = translate_to

    return {
        "video_id": video_id,
        "title": info.get("title") or f"YouTube Video ({video_id})",
        "author": info.get("uploader") or "",
        "thumbnail_url": info.get("thumbnail")
        or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "selected_language": chosen_lang,
        "selected_language_name": chosen_lang,
        "is_generated": is_generated,
        "translate_language": applied_translation,
        "seg_mode": seg_mode,
        "available_tracks": available_tracks,
        "segments": segments,
    }


def fetch_raw_and_word_tokens(selected_tr: Any) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Fetch both normalized raw caption lines and word-level timestamp tokens from a
    YouTubeTranscriptApi Transcript object. Attempts fmt=json3 first for exact word-level
    timestamps, then falls back to standard XML snippets if needed.
    """
    try:
        json3_url = selected_tr._url
        if "fmt=" not in json3_url:
            json3_url += "&fmt=json3"
        resp = selected_tr._http_client.get(json3_url)
        if resp.status_code == 200:
            sub_data = resp.json()
            raw_lines, word_tokens = parse_json3_events_to_tokens(sub_data)
            if word_tokens:
                return raw_lines, word_tokens
    except Exception as exc:
        print(f"[Info] json3 word-token fetch fallback ({exc})", file=sys.stderr)

    # Fallback to standard XML transcript fetch
    fetched_primary = selected_tr.fetch()
    raw_primary = fetched_primary.to_raw_data()
    normalized = normalize_raw_segments(raw_primary)
    return normalized, normalized


def get_video_transcript(
    video_id: str,
    lang: Optional[str] = None,
    translate_to: Optional[str] = None,
    seg_mode: str = "sentence",
) -> Dict[str, Any]:
    """
    Fetch transcript and metadata for a YouTube video ID.
    Supports choosing primary subtitle language, optional translation language,
    and segmentation mode ('sentence', 'clause', or 'raw').
    """
    if seg_mode not in ("sentence", "clause", "raw"):
        seg_mode = "sentence"

    cache_key = f"v2:{video_id}:{lang or 'auto'}:{translate_to or 'none'}:{seg_mode}"
    if cache_key in TRANSCRIPT_CACHE:
        return TRANSCRIPT_CACHE[cache_key]

    meta = fetch_video_metadata(video_id)
    ytt_api = YouTubeTranscriptApi()

    try:
        transcript_list = ytt_api.list(video_id)
        available_tracks = []
        manual_tracks = []
        generated_tracks = []

        for tr in transcript_list:
            track_info = {
                "language_code": tr.language_code,
                "language": tr.language,
                "is_generated": tr.is_generated,
                "is_translatable": tr.is_translatable,
            }
            available_tracks.append(track_info)
            if tr.is_generated:
                generated_tracks.append(tr)
            else:
                manual_tracks.append(tr)

        selected_tr = None
        if lang:
            for tr in transcript_list:
                if tr.language_code == lang:
                    selected_tr = tr
                    break

        if selected_tr is None:
            if manual_tracks:
                selected_tr = manual_tracks[0]
            elif generated_tracks:
                selected_tr = generated_tracks[0]

        if selected_tr is None:
            raise ValueError("未找到可用的字幕轨道。")

        raw_lines, word_tokens = fetch_raw_and_word_tokens(selected_tr)
        if seg_mode == "raw":
            segments = [dict(item) for item in raw_lines]
        else:
            segments = build_smart_sentences(word_tokens, seg_mode=seg_mode)

        applied_translation = ""
        if translate_to and translate_to != selected_tr.language_code:
            if translate_segments_via_gtx(segments, translate_to):
                applied_translation = translate_to

        result = {
            "video_id": video_id,
            "title": meta["title"],
            "author": meta["author"],
            "thumbnail_url": meta["thumbnail_url"],
            "selected_language": selected_tr.language_code,
            "selected_language_name": selected_tr.language,
            "is_generated": selected_tr.is_generated,
            "translate_language": applied_translation,
            "seg_mode": seg_mode,
            "available_tracks": available_tracks,
            "segments": segments,
        }
        TRANSCRIPT_CACHE[cache_key] = result
        return result

    except Exception as primary_err:
        print(
            f"[Info] Primary transcript API failed ({primary_err}), trying yt-dlp fallback...",
            file=sys.stderr,
        )
        result = fetch_subtitles_via_ytdlp(
            video_id, preferred_lang=lang, translate_to=translate_to, seg_mode=seg_mode
        )
        TRANSCRIPT_CACHE[cache_key] = result
        return result


class SubtitleAppRequestHandler(SimpleHTTPRequestHandler):
    """HTTP handler serving static frontend assets and /api/transcript JSON endpoints."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def send_json(self, status_code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/transcript":
            qs = urllib.parse.parse_qs(parsed.query)
            raw_url = (qs.get("url") or [""])[0]
            lang = (qs.get("lang") or [""])[0] or None
            translate_to = (qs.get("translate") or [""])[0] or None
            seg_mode = (qs.get("mode") or ["sentence"])[0]

            video_id, is_shorts = extract_video_id(raw_url)
            if not video_id:
                self.send_json(
                    400,
                    {
                        "ok": False,
                        "error": "无法识别该 YouTube 链接或视频 ID，请输入有效的 YouTube 视频或 Shorts 链接。",
                    },
                )
                return

            try:
                data = get_video_transcript(
                    video_id, lang=lang, translate_to=translate_to, seg_mode=seg_mode
                )
                data["is_shorts"] = is_shorts
                self.send_json(200, {"ok": True, "data": data})
            except Exception as exc:
                self.send_json(
                    500,
                    {
                        "ok": False,
                        "error": f"获取字幕失败：{str(exc)}",
                    },
                )
            return

        if parsed.path == "/api/health":
            self.send_json(200, {"ok": True, "status": "running"})
            return

        return super().do_GET()


def main() -> None:
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), SubtitleAppRequestHandler)
    print("============================================================")
    print(" YouTube 外语字幕跟读学习应用已启动！")
    print(f" 本地访问地址: http://127.0.0.1:{port}")
    print("============================================================", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭服务...")
        server.server_close()


if __name__ == "__main__":
    main()
