// MinenkoY
window.LyricsEngine = (function () {
  "use strict";

  const contentEl = () => document.getElementById("lyrics-content");

  let lines = [];
  let type = "none";
  let activeIndex = -1;
  let snapNext = false;
  let emphasisMode = "dynamic";
  let emphStrength = 1;
  let glowStrength = 1;
  let interludesOn = true;
  let seekHandler = null;
  let subtitles = null;          // per source line: translation / romanization, or ""
  const INTERLUDE_MIN_GAP = 3000;

  // Emphasis curves as [progress, value] keyframes, smoothstep-interpolated.
  // WIDE = syllables held long enough to breathe, TIGHT = short ones.
  const LIFT_WIDE   = [[0, 0.95], [0.7, 1.18], [1, 1]];
  const LIFT_TIGHT  = [[0, 0.95], [0.7, 1.07], [1, 1]];
  const RISE_WIDE   = [[0, 0.018], [0.9, -0.018], [1, 0]];
  const RISE_TIGHT  = [[0, 0.010], [0.9, -0.016], [1, 0]];
  const FLARE       = [[0, 0], [0.15, 1], [0.6, 1], [1, 0]];
  const WIDE_MIN_MS = 1000;

  // How the effect decays away from the letter currently being sung.
  const FALLOFF_LIFT_EXP = 2.8;
  const FALLOFF_FLARE_K = 0.9;
  const FLARE_ALPHA_GAIN = 1.85;

  // Spring tuning: [frequency, dampingRatio]
  const SPRING_LIFT  = [2.3, 0.70];
  const SPRING_RISE  = [2.6, 0.55];
  const SPRING_FLARE = [1.6, 0.56];

  function sampleCurve(pts, t) {
    if (t <= pts[0][0]) return pts[0][1];
    const last = pts[pts.length - 1];
    if (t >= last[0]) return last[1];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (t >= a[0] && t <= b[0]) {
        let u = (t - a[0]) / (b[0] - a[0]);
        u = u * u * (3 - 2 * u);
        return a[1] + (b[1] - a[1]) * u;
      }
    }
    return last[1];
  }

  const PHASE_IDLE = "is-idle";
  const PHASE_LIVE = "is-live";
  const PHASE_DONE = "is-done";

  function phaseAt(currentTime, startTime, endTime) {
    if (currentTime < startTime) return PHASE_IDLE;
    if (currentTime >= endTime) return PHASE_DONE;
    return PHASE_LIVE;
  }

  // 0 = nothing sung yet, 1 = fully sung. The CSS turns this into gradient stops.
  function wipeProgress(currentTime, startTime, endTime) {
    const p = (currentTime - startTime) / (endTime - startTime);
    if (!isFinite(p) || p < 0) return 0;
    return p > 1 ? 1 : p;
  }

  function setWipe(el, progress) {
    const v = progress.toFixed(3);
    if (el.__wipe === v) return;
    el.__wipe = v;
    el.style.setProperty("--wipe", v);
  }

  function blurForDistance(d) {
    if (d <= 0) return 0;
    if (d === 1) return 2;
    if (d === 2) return 4;
    return 6;
  }

  function clear() {
    contentEl().textContent = "";
    lines = [];
    activeIndex = -1;
    type = "none";
  }

  function buildWord(text, startMs, endMs) {
    const wg = document.createElement("span");
    wg.className = "wg";
    const letters = [];
    Array.from(text).forEach((ch) => {
      const lt = document.createElement("span");
      lt.className = "fill ltr";
      lt.textContent = ch;
      letters.push({
        el: lt,
        scaleSpring: new Spring(SPRING_LIFT[0], SPRING_LIFT[1], 1),
        ySpring: new Spring(SPRING_RISE[0], SPRING_RISE[1], 0),
        glowSpring: new Spring(SPRING_FLARE[0], SPRING_FLARE[1], 0),
        last: null,
      });
      wg.appendChild(lt);
    });
    return { wg, startMs, endMs, state: null, letters };
  }

  function spaceEl() {
    const s = document.createElement("span");
    s.className = "fill sp";
    s.textContent = " ";
    return s;
  }

  function pushInterlude(startMs, endMs, frag) {
    const el = document.createElement("div");
    el.className = "interlude";
    el.style.setProperty("--depth-blur", "0px");
    const dots = [];
    for (let i = 0; i < 3; i++) {
      const d = document.createElement("span");
      d.className = "dot";
      el.appendChild(d);
      dots.push(d);
    }
    frag.appendChild(el);
    lines.push({
      el, startMs, endMs, isInterlude: true, isBackground: false,
      state: null, lineMode: false, words: [], allLetters: [], dots,
    });
  }

  function setLyrics(data) {
    clear();
    if (!data || !data.lines || !data.lines.length) { type = "none"; return; }
    type = data.type || "line";
    const frag = document.createDocumentFragment();
    let prevEnd = null;

    data.lines.forEach((l) => {
      const gapStart = prevEnd == null ? 0 : prevEnd;
      if (l.startMs - gapStart >= INTERLUDE_MIN_GAP) pushInterlude(gapStart, l.startMs, frag);

      const el = document.createElement("div");
      el.className = "line " + PHASE_IDLE + (l.isBackground ? " bg-line" : "");
      el.style.setProperty("--depth-blur", "0px");

      const sourceIndex = data.lines.indexOf(l);
      el.addEventListener("click", () => { if (seekHandler) seekHandler(l.startMs); });
      const rec = {
        el, sourceIndex, startMs: l.startMs, endMs: l.endMs,
        isBackground: !!l.isBackground, state: null,
        lineMode: true, words: [], allLetters: [],
      };

      let wordDefs;
      let generated = false;
      if (type === "syllable" && Array.isArray(l.words) && l.words.length) {
        rec.lineMode = false;
        wordDefs = l.words.map((w) => ({ text: String(w.text).trim(), startMs: w.startMs, endMs: w.endMs }));
      } else {

        generated = true;
        // Line-timed lyrics: spread the words at a sung pace (longer words take longer)
        // instead of stretching them over the whole line, so they light up word by word.
        rec.lineMode = false;
        const tokens = (l.text || " ").split(/\s+/).filter((t) => t.length);
        const span = Math.max(400, l.endMs - l.startMs);
        const natural = tokens.reduce((a, t) => a + 180 + t.length * 55, 0);
        const sung = Math.min(span * 0.92, Math.max(span * 0.5, natural));
        const total = tokens.reduce((a, t) => a + t.length + 1, 0) || 1;
        let at = l.startMs;
        wordDefs = tokens.map((t) => {
          const len = (sung * (t.length + 1)) / total;
          const w = { text: t, startMs: at, endMs: at + len };
          at += len;
          return w;
        });
      }

      wordDefs.forEach((w, i) => {
        const word = buildWord(w.text, w.startMs, w.endMs);
        rec.words.push(word);
        rec.allLetters.push(...word.letters);
        el.appendChild(word.wg);
        if (i < wordDefs.length - 1) el.appendChild(spaceEl());
      });

      // The next gap starts when this line's last word ends (a line-timed line "lasts" until
      // the next one, which would hide every instrumental break).
      const lastWord = rec.words[rec.words.length - 1];
      // A line-timed line is done shortly after its last (paced) word, not when the next one starts.
      if (generated && lastWord) rec.endMs = Math.min(rec.endMs, lastWord.endMs + 700);
      if (!l.isBackground) prevEnd = Math.max(prevEnd || 0, lastWord ? lastWord.endMs : l.endMs);
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = (subtitles && subtitles[sourceIndex]) || "";
      el.appendChild(sub);
      rec.sub = sub;
      frag.appendChild(el);
      lines.push(rec);
    });

    if (data.writers && data.writers.length) {
      const credit = document.createElement("div");
      credit.className = "credits";
      credit.textContent = "Written by " + data.writers.join(", ");
      frag.appendChild(credit);
    }

    contentEl().appendChild(frag);
    contentEl().classList.toggle("no-interludes", !interludesOn);

    if (type === "static") {
      lines.forEach((r) => {
        r.el.classList.remove(PHASE_IDLE);
        r.el.classList.add(PHASE_LIVE);
        setWipe(r.el, 1);
      });
      return;
    }
    snapNext = true;
  }

  function setLinePhase(rec, phase) {
    if (rec.state === phase) return false;
    rec.state = phase;
    rec.el.classList.remove(PHASE_IDLE, PHASE_LIVE, PHASE_DONE);
    rec.el.classList.add(phase);
    return true;
  }

  function applyDepth(active) {
    for (let i = 0; i < lines.length; i++) {
      const d = active < 0 ? 99 : Math.abs(i - active);
      lines[i].el.style.setProperty("--depth-blur", blurForDistance(d) + "px");
    }
  }

  function clearLetter(lt) {
    lt.scaleSpring.reset(1);
    lt.ySpring.reset(0);
    lt.glowSpring.reset(0);
    lt.el.style.transform = "";
    lt.el.style.removeProperty("--flare-blur");
    lt.el.style.removeProperty("--flare-alpha");
    lt.last = null;
  }

  function resetLetters(rec) {
    if (!rec) return;
    for (const lt of rec.allLetters) clearLetter(lt);
  }

  function emphasizeSegment(letters, start, end, currentTime, dt, wide) {
    const dur = end - start || 1;
    let p = (currentTime - start) / dur;
    if (p < 0) p = 0; else if (p > 1) p = 1;

    const live = currentTime >= start && currentTime < end;
    const baseScale = live ? sampleCurve(wide ? LIFT_WIDE : LIFT_TIGHT, p) : 1;
    const baseY = live ? sampleCurve(wide ? RISE_WIDE : RISE_TIGHT, p) : 0;
    const baseGlow = live ? sampleCurve(FLARE, p) : 0;
    const head = p * letters.length;

    for (let i = 0; i < letters.length; i++) {
      const lt = letters[i];
      const dist = Math.abs(i - head);
      const fScale = Math.max(0, 1 / (1 + Math.pow(dist, FALLOFF_LIFT_EXP)));
      const fGlow = Math.max(0, 1 / (1 + dist * FALLOFF_FLARE_K));

      lt.scaleSpring.setGoal(1 + (baseScale - 1) * fScale * emphStrength);
      lt.ySpring.setGoal(baseY * fScale * emphStrength);
      lt.glowSpring.setGoal(Math.min(1.4, baseGlow * fGlow * glowStrength));
      const s = lt.scaleSpring.Step(dt);
      const y = lt.ySpring.Step(dt);
      const g = lt.glowSpring.Step(dt);

      const key = (s * 1000 | 0) + ":" + (y * 10000 | 0) + ":" + (g * 1000 | 0);
      if (lt.last === key) continue;
      lt.last = key;

      lt.el.style.transform =
        `translate3d(0, calc(var(--line-type-size) * ${(y * 2).toFixed(4)}), 0) scale(${s.toFixed(4)})`;
      lt.el.style.setProperty("--flare-blur", (4 + 12 * g).toFixed(2) + "px");
      lt.el.style.setProperty("--flare-alpha", Math.min(1, g * FLARE_ALPHA_GAIN).toFixed(3));
    }
  }

  function emphasizeLine(rec, currentTime, dt) {
    for (const w of rec.words) {
      const wide = rec.lineMode || (w.endMs - w.startMs) >= WIDE_MIN_MS;
      emphasizeSegment(w.letters, w.startMs, w.endMs, currentTime, dt, wide);
    }
  }

  function updateInterlude(rec, currentTime) {
    let p = (currentTime - rec.startMs) / (rec.endMs - rec.startMs);
    if (p < 0) p = 0; else if (p > 1) p = 1;
    for (let i = 0; i < 3; i++) {
      let local = p * 3 - i;
      if (local < 0) local = 0; else if (local > 1) local = 1;
      const breathe = 0.06 * Math.sin(currentTime / 280 + i * 1.1);
      rec.dots[i].style.opacity = (0.28 + 0.72 * local).toFixed(3);
      rec.dots[i].style.transform = `scale(${(0.72 + 0.42 * local + breathe).toFixed(3)})`;
    }
  }

  function update(currentTime, dt) {
    if (type === "none" || type === "static" || !lines.length) return;
    if (dt == null || !isFinite(dt) || dt <= 0) dt = 1 / 60;

    let ai = -1, aiPrimary = -1;
    for (let i = 0; i < lines.length; i++) {
      const r = lines[i];
      if (r.isInterlude && !interludesOn) continue;
      if (r.startMs <= currentTime) {
        ai = i;
        if (!r.isBackground && currentTime < r.endMs) aiPrimary = i;
      } else break;
    }

    let scrollTarget = ai;
    if (ai >= 0 && lines[ai].isBackground && aiPrimary >= 0 && aiPrimary !== ai) {
      scrollTarget = aiPrimary;
    }

    for (let i = 0; i < lines.length; i++) {
      const rec = lines[i];
      if (rec.isInterlude) continue;
      const ph = phaseAt(currentTime, rec.startMs, rec.endMs);
      const changed = setLinePhase(rec, ph);

      if (rec.lineMode) {
        if (ph === PHASE_LIVE) setWipe(rec.el, wipeProgress(currentTime, rec.startMs, rec.endMs));
        else if (changed) setWipe(rec.el, ph === PHASE_DONE ? 1 : 0);
      } else {
        for (const w of rec.words) {
          const wp = phaseAt(currentTime, w.startMs, w.endMs);
          if (wp === PHASE_LIVE) {
            // the sweep moves letter by letter through the word
            const p = wipeProgress(currentTime, w.startMs, w.endMs) * w.letters.length;
            for (let k = 0; k < w.letters.length; k++) {
              const lp = p - k;
              setWipe(w.letters[k].el, lp <= 0 ? 0 : lp >= 1 ? 1 : lp);
            }
            w.state = PHASE_LIVE;
          } else if (w.state !== wp) {
            const v = wp === PHASE_DONE ? 1 : 0;
            for (const lt of w.letters) setWipe(lt.el, v);
            w.state = wp;
          }
        }
      }
    }

    if (scrollTarget !== activeIndex) {
      const prev = lines[activeIndex];
      if (prev) { if (prev.isInterlude) prev.el.classList.remove("active"); else resetLetters(prev); }
      activeIndex = scrollTarget;
      applyDepth(scrollTarget);
      if (scrollTarget >= 0) {
        const cur = lines[scrollTarget];
        if (cur.isInterlude) cur.el.classList.add("active");
        ScrollController.setActiveLine(cur.el, snapNext);
        snapNext = false;
      }
    }

    if (scrollTarget >= 0) {
      const cur = lines[scrollTarget];
      if (cur.isInterlude) updateInterlude(cur, currentTime);
      else if (emphasisMode === "dynamic") emphasizeLine(cur, currentTime, dt);
    }
  }

  function forceSnap() { snapNext = true; }

  function setEmphasis(mode) {
    emphasisMode = (mode === false || mode === "flat" || mode === "simple") ? "flat" : "dynamic";
    if (emphasisMode === "flat" && activeIndex >= 0) resetLetters(lines[activeIndex]);
  }

  function setEmphasisStrength(f) { emphStrength = isFinite(f) ? f : 1; }
  function setGlowStrength(f) { glowStrength = isFinite(f) ? f : 1; }
  function setSeekHandler(fn) { seekHandler = fn; }

  /** Translations or romanizations, one per source line ("" for none); shown under each line. */
  function setSubtitles(list) {
    subtitles = list && list.length ? list : null;
    for (const rec of lines) {
      if (rec.sub) rec.sub.textContent = (subtitles && subtitles[rec.sourceIndex]) || "";
    }
  }

  function setInterludes(on) {
    interludesOn = !!on;
    contentEl().classList.toggle("no-interludes", !interludesOn);
  }

  return {
    setLyrics, update, forceSnap, setEmphasis,
    setEmphasisStrength, setGlowStrength, setInterludes, setSeekHandler, setSubtitles,
  };
})();
