// Lyrics lookup in the wallpaper itself, used for Windows Media (no relay) and to upgrade
// line-timed lyrics from the relay to word-by-word ones when a better source has them.
//
// Sources, best first: RMM Revival (Apple Music / Spicy Lyrics syncs, word by word, found by
// the song's Apple Music ID), then LRCLIB (line synced). Plus translation and romanization
// through Google's free endpoint. Every host here answers browsers (CORS) directly.
window.LyricsSources = (function () {
  "use strict";

  const cache = new Map();

  const plain = (text) =>
    String(text || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s*[([][^)\]]*(feat|ft\.|with|remaster|version|edit|live|mix|official|lyric|audio|video|visualizer)[^)\]]*[)\]]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const loose = (a, b) => {
    const x = plain(a), y = plain(b);
    return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
  };

  /** The first artist of "A, B & C" / "A feat. B" / "A x B". */
  const leadArtist = (artist) =>
    String(artist || "").split(/\s*(?:,|;|&|\/| feat\.? | ft\.? | x | and )\s*/i)[0] || artist || "";

  /**
   * A track as players report it, cleaned for lookups: browsers send YouTube titles like
   * "Artist - Title (Official Video)" with the channel as artist; " - Topic" channels;
   * Spotify sends "A, B" artists.
   */
  function cleanTrack(track) {
    let title = String(track.title || "").trim();
    let artist = String(track.artist || "").trim().replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "");
    const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dash && (!artist || loose(dash[1], artist) || /youtube|chrome|edge|firefox|brave|opera/i.test(track.app || ""))) {
      artist = dash[1];
      title = dash[2];
    }
    title = title
      .replace(/\s*[([][^)\]]*(official|lyric|audio|video|visualizer|mv|m\/v|hd|4k)[^)\]]*[)\]]/gi, "")
      .replace(/\s*\|.*$/, "")
      .trim();
    return { title, artist, album: track.album || "", durationMs: Number(track.durationMs) || 0 };
  }

  async function getJson(url, ms) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ms || 9000) : 0;
    try {
      const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- parsing -----------------------------------------------------------------------

  function seconds(raw) {
    if (raw == null || raw === "") return null;
    const text = String(raw).trim();
    if (text.endsWith("ms")) return parseFloat(text) / 1000;
    if (text.endsWith("s") && !text.includes(":")) return parseFloat(text);
    return text.split(":").map(parseFloat).reduce((t, p) => t * 60 + p, 0);
  }

  /** TTML (Apple Music style) to the wallpaper's lyrics shape. */
  function parseTtml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    const META = "http://www.w3.org/ns/ttml#metadata";
    const role = (n) => n.getAttribute("ttm:role") || n.getAttributeNS(META, "role");
    const ps = Array.from(doc.getElementsByTagName("p"));
    let wordTimed = false;
    const lines = [];
    for (const p of ps) {
      const words = [];
      const bg = [];
      const collect = (node, into) => {
        let space = false;
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === 3) { if (/\s/.test(child.nodeValue || "")) space = true; continue; }
          if (child.nodeType !== 1 || child.localName !== "span") continue;
          const r = role(child);
          if (r === "x-bg") { collect(child, bg); continue; }
          if (r === "x-translation" || r === "x-roman") continue;
          const start = seconds(child.getAttribute("begin"));
          const end = seconds(child.getAttribute("end"));
          const value = child.textContent || "";
          if (start == null || !value.trim()) continue;
          wordTimed = true;
          const joined = into.length > 0 && !space && !/^\s/.test(value);
          if (joined) {
            // a syllable glued to the previous one: same word on screen
            const prev = into[into.length - 1];
            prev.text += value.trim();
            prev.endMs = (end != null ? end : start) * 1000;
          } else into.push({ text: value.trim(), startMs: start * 1000, endMs: (end != null ? end : start) * 1000 });
          space = /\s$/.test(value);
        }
      };
      collect(p, words);
      const startMs = (seconds(p.getAttribute("begin")) || 0) * 1000;
      const endMs = (seconds(p.getAttribute("end")) || 0) * 1000;
      const text = words.length ? words.map((w) => w.text).join(" ") : (p.textContent || "").trim();
      if (!text) continue;
      lines.push({ startMs, endMs: Math.max(endMs, startMs), text, isBackground: false, words });
      if (bg.length) {
        lines.push({
          startMs: bg[0].startMs,
          endMs: bg[bg.length - 1].endMs,
          text: bg.map((w) => w.text).join(" "),
          isBackground: true,
          words: bg,
        });
      }
    }
    if (!lines.length) return null;
    const writers = Array.from(doc.getElementsByTagName("songwriter")).map((n) => n.textContent.trim()).filter(Boolean);
    return { type: wordTimed ? "syllable" : "line", lines, writers };
  }

  const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  const stampMs = (m, s) => (parseInt(m, 10) * 60 + parseFloat(String(s).replace(":", "."))) * 1000;

  /** LRC, including enhanced <mm:ss.xx> word stamps. */
  function parseLrc(text, durationMs) {
    const rows = [];
    let wordTimed = false;
    for (const raw of String(text).split(/\r?\n/)) {
      const stamps = Array.from(raw.matchAll(STAMP));
      if (!stamps.length) continue;
      let body = raw.replace(STAMP, "");
      const words = [];
      const ws = Array.from(body.matchAll(/<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>([^<]*)/g));
      if (ws.length) {
        wordTimed = true;
        ws.forEach((m, i) => {
          const start = stampMs(m[1], m[2]);
          const next = ws[i + 1];
          if (m[3].trim()) words.push({ text: m[3].trim(), startMs: start, endMs: next ? stampMs(next[1], next[2]) : start + 600 });
        });
        body = words.map((w) => w.text).join(" ");
      }
      for (const st of stamps) rows.push({ startMs: stampMs(st[1], st[2]), text: body.trim(), words: words.slice() });
    }
    rows.sort((a, b) => a.startMs - b.startMs);
    const lines = [];
    rows.forEach((r, i) => {
      if (!r.text) return;
      const next = rows[i + 1];
      const t = r.text;
      lines.push({
        startMs: r.startMs,
        endMs: next ? next.startMs : (durationMs || r.startMs + 5000),
        text: t,
        isBackground: t.length > 1 && t[0] === "(" && t[t.length - 1] === ")",
        words: r.words,
      });
    });
    return lines.length ? { type: wordTimed ? "syllable" : "line", lines } : null;
  }

  function plainLyrics(text) {
    const lines = String(text || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      .map((x, i) => ({ startMs: i, endMs: i + 1, text: x, isBackground: false, words: [] }));
    return lines.length ? { type: "static", lines } : null;
  }

  // ---- sources ----------------------------------------------------------------------

  async function appleSong(t) {
    const artist = leadArtist(t.artist);
    const found = await getJson("https://itunes.apple.com/search?entity=song&limit=10&term=" + encodeURIComponent(artist + " " + t.title));
    const songs = ((found && found.results) || []).filter((s) => loose(s.artistName, artist) && loose(s.trackName, t.title));
    if (t.durationMs > 0) songs.sort((a, b) => Math.abs((a.trackTimeMillis || 0) - t.durationMs) - Math.abs((b.trackTimeMillis || 0) - t.durationMs));
    return songs[0] || null;
  }

  async function fromRmm(apple) {
    if (!apple || !apple.trackId) return null;
    const data = await getJson("https://lyrics.rmmreviv.al/lyrics?id=" + apple.trackId);
    if (!data) return null;
    const text = ["ttml", "content", "syncedLyrics", "lyrics"].map((k) => data[k]).find((v) => typeof v === "string" && v.trim());
    if (!text) return null;
    if (/<tt[\s>]/i.test(text)) return parseTtml(text);
    if (/\[\d{1,3}:\d{2}/.test(text)) return parseLrc(text);
    return null;
  }

  async function fromLrclib(t) {
    const q = new URLSearchParams({ artist_name: leadArtist(t.artist), track_name: t.title });
    if (t.album) q.set("album_name", t.album);
    if (t.durationMs) q.set("duration", String(Math.round(t.durationMs / 1000)));
    const exact = await getJson("https://lrclib.net/api/get?" + q);
    if (exact && exact.syncedLyrics) return parseLrc(exact.syncedLyrics, t.durationMs);
    const list = await getJson("https://lrclib.net/api/search?" + new URLSearchParams({ track_name: t.title, artist_name: leadArtist(t.artist) }));
    const hits = (Array.isArray(list) ? list : []).filter((h) => h && (h.syncedLyrics || h.plainLyrics) && !h.instrumental);
    if (t.durationMs) hits.sort((a, b) => Math.abs(a.duration * 1000 - t.durationMs) - Math.abs(b.duration * 1000 - t.durationMs));
    const synced = hits.find((h) => h.syncedLyrics && (!t.durationMs || Math.abs(h.duration * 1000 - t.durationMs) < 15000));
    if (synced) return parseLrc(synced.syncedLyrics, t.durationMs);
    if (exact && exact.plainLyrics) return plainLyrics(exact.plainLyrics);
    return hits[0] && hits[0].plainLyrics ? plainLyrics(hits[0].plainLyrics) : null;
  }

  /** The best lyrics for a track: word-synced if anyone has them. Resolves to null when none. */
  async function find(track, opts) {
    const t = cleanTrack(track);
    if (!t.title) return null;
    const key = plain(t.artist) + "|" + plain(t.title);
    if (cache.has(key)) return cache.get(key);
    const job = (async () => {
      let apple = null;
      try { apple = await appleSong(t); } catch (_) {}
      const word = await fromRmm(apple).catch(() => null);
      if (word && word.type === "syllable") return Object.assign(word, { source: "Apple Music / Spicy Lyrics", artwork: art(apple) });
      if (opts && opts.wordOnly) return null;
      const line = await fromLrclib(t).catch(() => null);
      const best = line || word;
      if (best) { best.source = line ? "LRCLIB" : "Apple Music"; best.artwork = art(apple); }
      return best;
    })();
    cache.set(key, job);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    const result = await job;
    if (!result) setTimeout(() => cache.delete(key), 5 * 60 * 1000); // try again later
    return result;
  }

  const art = (apple) => (apple && apple.artworkUrl100 ? apple.artworkUrl100.replace(/100x100bb/, "600x600bb") : "");

  // ---- translation & romanization --------------------------------------------------

  const NON_LATIN = /[Ͱ-ϿЀ-ӿ֐-ۿऀ-෿฀-໿぀-ヿ㐀-鿿가-힯]/;
  const subtitleCache = new Map();

  async function gtx(lines, params) {
    const out = [];
    for (let i = 0; i < lines.length; i += 30) {
      const chunk = lines.slice(i, i + 30).map((t) => t.replace(/\n/g, " "));
      const q = new URLSearchParams(Object.assign({ client: "gtx", sl: "auto", q: chunk.join("\n") }, params));
      const data = await getJson("https://translate.googleapis.com/translate_a/single?" + q);
      out.push({ chunk, data });
    }
    return out;
  }

  /** Each line translated to [target], "" where it already is in that language. */
  async function translate(lyrics, target) {
    const texts = lyrics.lines.map((l) => l.text);
    const key = "t:" + target + ":" + texts.join("\n");
    if (subtitleCache.has(key)) return subtitleCache.get(key);
    const result = [];
    for (const { chunk, data } of await gtx(texts, { tl: target, dt: "t" })) {
      const parts = ((data && data[0]) || []).map((p) => (p && p[0]) || "").join("").split("\n");
      const same = data && data[2] === target;
      chunk.forEach((orig, i) => {
        const tr = (parts.length === chunk.length ? parts[i] : "").trim();
        result.push(same || plain(tr) === plain(orig) ? "" : tr);
      });
    }
    subtitleCache.set(key, result);
    return result;
  }

  /** Each non-Latin line in Latin letters (Japanese, Korean, Chinese, Cyrillic, Arabic...). */
  async function romanize(lyrics) {
    const texts = lyrics.lines.map((l) => l.text);
    const key = "r:" + texts.join("\n");
    if (subtitleCache.has(key)) return subtitleCache.get(key);
    const result = texts.map(() => "");
    const todo = texts.map((t, i) => [i, t]).filter(([, t]) => NON_LATIN.test(t));
    if (todo.length) {
      let at = 0;
      for (const { chunk, data } of await gtx(todo.map(([, t]) => t), { tl: "en", dt: "rm" })) {
        const parts = ((data && data[0]) || []).map((p) => (p && p[3]) || "").join("").split("\n");
        chunk.forEach((_, i) => {
          const value = parts.length === chunk.length ? parts[i].trim() : "";
          result[todo[at + i][0]] = value;
        });
        at += chunk.length;
      }
    }
    subtitleCache.set(key, result);
    return result;
  }

  return { find, translate, romanize, cleanTrack, leadArtist, parseTtml, parseLrc };
})();
