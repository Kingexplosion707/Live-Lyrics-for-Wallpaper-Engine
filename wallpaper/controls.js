// Playback controls on the wallpaper (Wallpaper Engine passes desktop clicks to it):
// previous / play-pause / next, like, shuffle, repeat, a clickable progress bar and "up next".
// Commands go to the relay; with Spotify + Spicetify every button works, with any other player
// the relay uses Windows' media controls (play/pause, previous, next, seek).
window.Controls = (function () {
  "use strict";

  const ICON = {
    prev: "M6 5h2v14H6zM20 5v14L9.5 12z",
    next: "M16 5h2v14h-2zM4 5l10.5 7L4 19z",
    play: "M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z",
    pause: "M6 5h4v14H6zM14 5h4v14h-4z",
    heart: "M12 21s-7.5-4.6-9.6-9.2C.9 8.5 3 5 6.5 5c2 0 3.5 1.2 4.5 2.6C12 6.2 13.5 5 15.5 5 19 5 21.1 8.5 19.6 11.8 17.5 16.4 12 21 12 21z",
    shuffle: "M17 3l4 4-4 4V8h-2.6l-2.2 2.6-1.3-1.5L13.5 6H17V3zM3 6h4.5l9.9 12H17v-3l4 4-4 4v-3h-3.5L4.6 8H3V6zm0 12h1.6l2.6-3.1 1.3 1.5L5.5 20H3v-2z",
    repeat: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z",
  };
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

  let api = null;
  let root = null;
  let playBtn = null;
  let extras = null;
  let upNextEl = null;
  let playing = false;
  let player = {};

  function button(name, title, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctl-btn " + (cls || "");
    b.title = title;
    b.innerHTML = svg(ICON[name]);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const cmd = { prev: "previous", next: "next", play: "toggle", heart: "like", shuffle: "shuffle", repeat: "repeat" }[name];
      if (api && api.send(cmd) && name === "play") setPlaying(!playing);
      pulse(b);
    });
    return b;
  }

  function pulse(el) {
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
  }

  function init(opts) {
    api = opts;
    const info = document.getElementById("info");
    root = document.createElement("div");
    root.id = "controls";
    extras = document.createElement("div");
    extras.className = "ctl-extras";
    const shuffle = button("shuffle", "Shuffle", "ctl-small ctl-shuffle");
    const prev = button("prev", "Previous");
    playBtn = button("play", "Play / pause", "ctl-main");
    const next = button("next", "Next");
    const repeat = button("repeat", "Repeat", "ctl-small ctl-repeat");
    const heart = button("heart", "Save to Liked Songs", "ctl-small ctl-heart");
    root.append(shuffle, prev, playBtn, next, repeat, heart);
    upNextEl = document.createElement("div");
    upNextEl.id = "up-next";
    info.appendChild(root);
    info.appendChild(upNextEl);

    // Click (or drag) on the progress bar to seek.
    const track = document.getElementById("progress-track");
    track.addEventListener("click", (e) => {
      const d = api.duration();
      if (!d) return;
      const r = track.getBoundingClientRect();
      const share = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      api.send("seek " + Math.round(share * d));
    });
    setInterval(refresh, 1000);
    refresh();
  }

  function setPlaying(on) {
    playing = !!on;
    document.body.classList.toggle("playing", playing);
    if (playBtn) playBtn.innerHTML = svg(playing ? ICON.pause : ICON.play);
  }

  /** Extra state only Spotify (Spicetify) knows: liked, shuffle, repeat, up next. */
  function setPlayer(p) {
    player = p || {};
    if (!root) return;
    root.classList.toggle("has-spotify", !!player.spotify);
    root.querySelector(".ctl-heart").classList.toggle("on", !!player.liked);
    root.querySelector(".ctl-shuffle").classList.toggle("on", !!player.shuffle);
    const rep = root.querySelector(".ctl-repeat");
    rep.classList.toggle("on", !!player.repeat);
    rep.classList.toggle("one", player.repeat === 2);
    upNextEl.textContent = player.next ? "Up next  ·  " + player.next : "";
  }

  function refresh() {
    if (!root || !api) return;
    root.classList.toggle("off", !api.canControl());
  }

  function setVisible(on) {
    document.body.classList.toggle("no-controls", !on);
  }

  return { init, setPlaying, setPlayer, setVisible };
})();
