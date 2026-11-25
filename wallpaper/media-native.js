// Built-in path (no install required): the track playing comes from Wallpaper Engine's media
// integration (Windows' media controls), and lyrics from LyricsSources (word-synced when
// Apple Music / Spicy Lyrics have them, else LRCLIB). The relay, when running, still wins.
//
// Accuracy notes:
//  - WE repeats the last timeline it got from the player, and players like Spotify only
//    update it on seek / play / pause. A repeated, unchanged position is therefore old, not
//    "now": it is ignored instead of snapping the lyrics back.
//  - A new song starts at 0 until its own timeline arrives (not at the old song's position).
window.MediaNative = (function () {
  "use strict";

  let handler = null;
  let statusHandler = null;
  const cur = { title: "", artist: "", album: "", coverUrl: "", durationMs: 0, app: "" };
  let lastKey = "";
  let isPlaying = false;
  let anchorPos = 0;          // ms, where the song was at anchorAt
  let anchorAt = Date.now();
  let lastRaw = -1;
  let lyrics = null;
  let fetchToken = 0;
  let enabled = null;

  const secToMs = (v) => Math.max(0, Math.round((Number(v) || 0) * 1000));

  function computePlaying(state) {
    const WM = window.wallpaperMediaIntegration;
    if (WM) {
      if (state === WM.PLAYBACK_PLAYING) return true;
      if (state === WM.PLAYBACK_PAUSED || state === WM.PLAYBACK_STOPPED) return false;
    }
    return state === 1 || state === true;
  }

  function normThumb(t) {
    if (!t) return "";
    t = String(t);
    if (/^(data:|https?:|file:|blob:)/i.test(t)) return t;
    return "data:image/png;base64," + t;
  }

  const position = () => anchorPos + (isPlaying ? Date.now() - anchorAt : 0);
  const track = () => ({ title: cur.title, artist: cur.artist, album: cur.album, coverUrl: cur.coverUrl, durationMs: cur.durationMs, app: cur.app });

  function emitFull() {
    if (handler && cur.title) handler({ track: track(), position: position(), isPlaying, timestamp: Date.now(), lyrics, source: "windows" });
  }
  function emitPosition() {
    if (handler && cur.title) handler({ position: position(), isPlaying, timestamp: Date.now(), source: "windows" });
  }

  function onNewTrack() {
    const key = cur.title + "|" + cur.artist;
    if (!cur.title) return;
    if (key === lastKey) { emitFull(); return; }
    lastKey = key;
    lyrics = null;
    anchorPos = 0;
    anchorAt = Date.now();
    lastRaw = -1;
    const token = ++fetchToken;
    emitFull();
    if (!window.LyricsSources) return;
    LyricsSources.find(cur).then((found) => {
      if (token !== fetchToken) return;
      lyrics = found;
      if (found && found.artwork && !cur.coverUrl) cur.coverUrl = found.artwork;
      emitFull();
    });
  }

  function register() {
    const w = window;
    if (typeof w.wallpaperRegisterMediaStatusListener === "function") {
      w.wallpaperRegisterMediaStatusListener((e) => {
        enabled = !!(e && e.enabled);
        if (statusHandler) statusHandler(enabled);
      });
    }
    if (typeof w.wallpaperRegisterMediaPropertiesListener === "function") {
      w.wallpaperRegisterMediaPropertiesListener((e) => {
        e = e || {};
        cur.title = e.title || "";
        cur.artist = e.artist || e.albumArtist || "";
        cur.album = e.albumTitle || "";
        cur.app = e.contentType || e.sourceAppId || "";
        if (!cur.title) {
          lastKey = "";
          if (handler) handler({ cleared: true, source: "windows" });
          return;
        }
        onNewTrack();
      });
    }
    if (typeof w.wallpaperRegisterMediaThumbnailListener === "function") {
      w.wallpaperRegisterMediaThumbnailListener((e) => {
        e = e || {};
        const thumb = normThumb(e.thumbnail);
        if (thumb && thumb !== cur.coverUrl) { cur.coverUrl = thumb; emitFull(); }
      });
    }
    if (typeof w.wallpaperRegisterMediaTimelineListener === "function") {
      w.wallpaperRegisterMediaTimelineListener((e) => {
        e = e || {};
        const dur = secToMs(e.duration);
        if (dur && dur !== cur.durationMs) { cur.durationMs = dur; emitFull(); }
        const raw = secToMs(e.position);
        // Same value as last time: the player hasn't updated its timeline, so it says nothing
        // about where the song is now. Keep extrapolating.
        if (raw === lastRaw) return;
        lastRaw = raw;
        const local = position();
        // Small backwards jitter while playing (a late report): keep the smoother clock.
        if (isPlaying && raw < local && local - raw < 1200) return;
        anchorPos = raw;
        anchorAt = Date.now();
        emitPosition();
      });
    }
    if (typeof w.wallpaperRegisterMediaPlaybackListener === "function") {
      w.wallpaperRegisterMediaPlaybackListener((e) => {
        e = e || {};
        const next = computePlaying(e.state);
        if (next === isPlaying) return;
        anchorPos = position();
        anchorAt = Date.now();
        isPlaying = next;
        emitPosition();
      });
    }
  }

  return {
    start(cb, onStatus) { handler = cb; statusHandler = onStatus || null; register(); },
    hasTrack: () => !!cur.title,
    /** null until WE says; false when the user turned media integration off. */
    enabled: () => enabled,
  };
})();
