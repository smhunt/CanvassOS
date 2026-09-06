#!/usr/bin/env python3
"""Narrate one line with OpenAI TTS.  usage: tts.py "text" out.wav

macOS `say` is the fallback, but with no enhanced voices installed it sounds like 2005. This is a
few hundred characters per build — fractions of a cent — and the difference is the whole video.
"""
import json, os, sys, urllib.request

text, out = sys.argv[1], sys.argv[2]
req = urllib.request.Request(
    "https://api.openai.com/v1/audio/speech",
    data=json.dumps({
        "model": "gpt-4o-mini-tts",
        "voice": "ash",
        "input": text,
        # Documentary, not advertising. The subject is a voters list and a by-law deadline.
        "instructions": "Calm, measured documentary narration. Unhurried and plain. "
                        "No salesmanship, no upward inflection, no enthusiasm.",
        "response_format": "wav",
    }).encode(),
    headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
             "Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=120) as r, open(out, "wb") as f:
    f.write(r.read())
