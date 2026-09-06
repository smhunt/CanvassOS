# 60-second explainer — narration

Voiced by OpenAI TTS (`gpt-4o-mini-tts`, voice `ash`) via `demo/tts.py`, falling back to macOS
`say` when no `OPENAI_API_KEY` is present. Each line is one scene, and the still is held for
exactly as long as its own audio — that is what keeps picture and voice in step with no manual
timing. Rebuild with `./demo/make_video.sh`.

1. MC Canvass is a door-knocking tool for one municipal campaign. It maps the whole voters list — seven thousand doors, sixteen thousand electors.

2. An organiser cuts the map into turfs — by street or by drawing a shape — sees the door count before committing, then hands each one to a volunteer.

3. Doors come in walking order, each carrying whatever happened there last time.

4. One tap records the result and moves to the next house. Speaking to someone opens support, flags and a note.

5. Rural signal is bad, so results queue on the phone and sync later. And when a battery dies, the turf prints on paper.

6. Lawn signs are logged with a GPS fix and a photo. They have to come down afterwards, and one nobody can find is a fine.

7. The list is personal information under the Municipal Elections Act. So it is self-hosted, every access is logged, and one command destroys it afterwards.
