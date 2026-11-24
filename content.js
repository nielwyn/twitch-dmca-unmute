"use strict";

/*
 * Plays Kick or clip audio over muted VOD ranges, synced to the player.
 * Clip start times are off by up to ~0.7 s, so clips are aligned by matching
 * small grayscale frames against the player.
 */
(() => {
  const TICK_MS = 150;
  const PLAN_RETRY_MS = 2000;
  const MAX_DRIFT = 0.2;
  const W = 32;
  const H = 18;
  const SEARCH_S = 2.0;      // +- seconds searched around the API estimate
  const GRID_S = 0.1;        // clip frame grid
  const SAMPLES = 24;        // player frames (~2 s) collected before matching
  const SAMPLE_GAP_S = 0.09;
  const CONFIDENT = 0.85;    // best error must be < 85% of the median error

  let plan = null;
  let planFor = null;
  let planAt = 0;
  let audio = null;
  let current = null;        // { clip, entry, url }
  let playError = null;
  /** slug -> { file: Promise<string|null>, shift, sync, samples, matching } */
  const clipState = new Map();

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const videoId = () => {
    const m = location.pathname.match(/^\/videos\/(\d+)/);
    return m ? m[1] : null;
  };

  /** [start, end] spans where Twitch's own audio was restored (originals injected). */
  let real = [];
  const isReal = (t) => real.some((r) => t >= r[0] && t < r[1]);

  let lastSent = "";
  let lastSentAt = 0;
  function debug(state) {
    const json = JSON.stringify(state);
    try {
      document.documentElement.dataset.dmcaUnmute = json;
    } catch (_) {}
    // Live state for the popup, on change or every 2 s.
    const key = [state.state, state.slug, state.sync, state.playError].join("|");
    if (key !== lastSent || Date.now() - lastSentAt > 2000) {
      lastSent = key;
      lastSentAt = Date.now();
      browser.runtime
        .sendMessage({ type: "clipState", state })
        .then((r) => r && Array.isArray(r.real) && (real = r.real))
        .catch(() => {});
    }
  }

  // Firefox may block play() until the user interacts; retry on the next click/key.
  let unlockArmed = false;
  function armUnlock() {
    if (unlockArmed) return;
    unlockArmed = true;
    const retry = () => {
      unlockArmed = false;
      document.removeEventListener("pointerdown", retry, true);
      document.removeEventListener("keydown", retry, true);
      if (audio && current && current.url) {
        audio.play().then(() => (playError = null), (err) => (playError = (err && err.name) || String(err)));
      }
    };
    document.addEventListener("pointerdown", retry, true);
    document.addEventListener("keydown", retry, true);
  }

  function mainVideo() {
    let best = null;
    for (const v of document.querySelectorAll("video")) {
      if (!best || v.clientWidth * v.clientHeight > best.clientWidth * best.clientHeight) best = v;
    }
    return best;
  }

  /** 32x18 grayscale thumbnail, or null if the frame can't be read. */
  function thumb(source) {
    try {
      ctx.drawImage(source, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      const out = new Uint8Array(W * H);
      for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
      return out;
    } catch (_) {
      return null; // tainted canvas or no frame yet
    }
  }

  function sad(a, b) {
    let n = 0;
    for (let i = 0; i < a.length; i++) n += Math.abs(a[i] - b[i]);
    return n;
  }

  /** Kick chunks are stable objects so `current.clip === clip` keeps working. */
  const kickClips = new Map();
  function kickClip(range, t, chunk) {
    const i = Math.max(0, Math.floor((t - range.start) / chunk));
    const a = range.start + i * chunk;
    if (a >= range.end) return null;
    const key = "kick:" + a.toFixed(2);
    let c = kickClips.get(key);
    if (!c) {
      c = { slug: key, kind: "kick", start: a, end: Math.min(range.end, a + chunk) };
      kickClips.set(key, c);
    }
    return c;
  }

  /** Keep only the Kick chunks near the playhead. */
  function pruneKick(t) {
    for (const [key, st] of clipState) {
      if (!key.startsWith("kick:")) continue;
      const c = kickClips.get(key);
      if (c && (c.end < t - 60 || c.start > t + 300)) {
        clipState.delete(key);
        kickClips.delete(key);
        if (st.file) st.file.then((url) => url && (!current || current.url !== url) && drop(url));
      }
    }
  }

  /** One <audio> per URL, so switching to a preloaded chunk doesn't stall. */
  const players = new Map();
  function player(url) {
    let a = players.get(url);
    if (!a) {
      a = new Audio();
      a.preload = "auto";
      a.src = url;
      players.set(url, a);
    }
    return a;
  }

  function drop(url) {
    const a = players.get(url);
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
      players.delete(url);
    }
    URL.revokeObjectURL(url);
  }

  /** Fetch a chunk and load it into its own element, for gapless switching. */
  function warm(clip) {
    if (!clip) return;
    const st = stateFor(clip);
    if (st.url) player(st.url);
  }

  function stateFor(clip) {
    const slug = clip.slug;
    let st = clipState.get(slug);
    if (!st) {
      st = { file: null, shift: 0, sync: clip.kind === "kick" ? "kick" : "estimate", samples: [], matching: false };
      clipState.set(slug, st);
    }
    if (!st.file) {
      const kick = clip.kind === "kick";
      const ask = kick
        ? { type: "kickChunk", videoId: planFor, a: clip.start, b: clip.end }
        : { type: "clipBytes", slug };
      st.file = browser.runtime
        .sendMessage(ask)
        .then((buf) => (buf ? URL.createObjectURL(new Blob([buf], { type: kick ? "audio/wav" : "video/mp4" })) : null))
        .catch(() => null);
      st.file.then((url) => {
        st.url = url;
        if (!url) setTimeout(() => (st.file = null), 30000);
      });
    }
    return st;
  }

  function seek(v, t) {
    return new Promise((resolve) => {
      const done = () => {
        v.removeEventListener("seeked", done);
        resolve();
      };
      v.addEventListener("seeked", done);
      v.currentTime = t;
      setTimeout(done, 1500);
    });
  }

  /** Find the clip start shift whose frames best match the sampled player frames. */
  async function match(clip, st) {
    st.matching = true;
    try {
      const url = await st.file;
      if (!url) return;
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.src = url;
      await new Promise((resolve, reject) => {
        v.onloadeddata = resolve;
        v.onerror = reject;
      });

      const samples = st.samples.slice();
      const rel = samples.map((s) => s.t - clip.start);
      const lo = Math.max(0, Math.min(...rel) - SEARCH_S);
      const hi = Math.min(v.duration || clip.end - clip.start, Math.max(...rel) + SEARCH_S);
      const grid = [];
      for (let t = lo; t <= hi + 1e-6; t += GRID_S) {
        await seek(v, t);
        const px = thumb(v);
        if (!px) {
          st.sync = "unreadable";
          return;
        }
        grid.push(px);
      }
      v.removeAttribute("src");
      v.load();

      const scores = [];
      for (let s = -SEARCH_S; s <= SEARCH_S + 1e-6; s += GRID_S) {
        let err = 0;
        let n = 0;
        for (let i = 0; i < samples.length; i++) {
          const k = Math.round((rel[i] - s - lo) / GRID_S);
          if (k < 0 || k >= grid.length) continue;
          err += sad(samples[i].px, grid[k]);
          n++;
        }
        if (n >= samples.length / 2) scores.push({ s, err: err / n });
      }
      if (scores.length < 5) return;
      const sorted = scores.map((x) => x.err).sort((a, b) => a - b);
      const best = scores.reduce((a, b) => (b.err < a.err ? b : a));
      const median = sorted[Math.floor(sorted.length / 2)];
      st.score = { best: Math.round(best.s * 100) / 100, ratio: Math.round((best.err / median) * 100) / 100, n: samples.length, grid: grid.length };
      if (best.err < CONFIDENT * median) {
        st.shift = Math.round(best.s * 100) / 100;
        st.sync = "matched";
      } else {
        st.sync = "unsure";
      }
      browser.runtime
        .sendMessage({ type: "clipPlaying", slug: clip.slug, at: samples[0].t, sync: st.sync, shift: st.shift })
        .catch(() => {});
    } catch (_) {
      st.sync = "failed";
    } finally {
      st.matching = false;
    }
  }

  function stop() {
    if (audio && !audio.paused) audio.pause();
    current = null;
  }

  async function refreshPlan() {
    const id = videoId();
    if (id !== planFor) {
      stop();
      plan = null;
      planFor = id;
      planAt = 0;
    }
    if (!id || (plan && plan.ready) || Date.now() - planAt < PLAN_RETRY_MS) return;
    planAt = Date.now();
    try {
      const p = await browser.runtime.sendMessage({ type: "clipPlan", videoId: id });
      if (videoId() === id) plan = p;
    } catch (_) {}
  }

  /** Run an extra tick exactly at a nearby range edge (the 150 ms tick can be late). */
  let edgeTimer = 0;
  function scheduleEdge(v, t) {
    if (edgeTimer || v.paused || v.seeking) return;
    let edge = Infinity;
    for (const r of plan.ranges.map((x) => [x.start, x.end]).concat(real)) {
      if (r[0] > t) edge = Math.min(edge, r[0]);
      if (r[1] > t) edge = Math.min(edge, r[1]);
    }
    const wait = (edge - t) / (v.playbackRate || 1);
    if (wait > TICK_MS / 1000 + 0.05) return;
    edgeTimer = setTimeout(() => {
      edgeTimer = 0;
      tick();
    }, Math.max(0, wait * 1000) + 5);
  }

  function tick() {
    refreshPlan();
    const v = mainVideo();
    if (!v || !plan || ((!plan.clips || plan.clips.length === 0) && !plan.kick)) {
      debug({ state: plan ? "no-clips" : "no-plan", t: v ? v.currentTime : undefined });
      return stop();
    }

    const t = v.currentTime;
    scheduleEdge(v, t);
    if (isReal(t)) {
      // The original segment is playing: Twitch already has the real audio here.
      debug({ state: "original", t });
      return stop();
    }
    const range = plan.ranges.find((r) => t >= r.start && t < r.end);
    const inMuted = !!range;
    if (plan.kick) {
      // Fetch the next range's first chunk before the playhead gets there.
      const next = plan.ranges.find((r) => r.start > t && r.start - t < 30);
      if (next) warm(kickClip(next, next.start, plan.kick.chunk));
    }
    let clip = null;
    if (inMuted && plan.kick) {
      // Full audio from Kick's copy of the stream, cut into chunks.
      clip = kickClip(range, t, plan.kick.chunk);
      if (clip && clip.end - t < 25 && clip.end < range.end) warm(kickClip(range, clip.end, plan.kick.chunk));
      pruneKick(t);
    } else if (inMuted) {
      for (const c of plan.clips) {
        const st = clipState.get(c.slug);
        const shift = st ? st.shift : 0;
        if (t >= c.start + shift && t < c.end + shift - 0.2 && (!clip || c.end > clip.end)) clip = c;
      }
      if (clip && current && current.clip !== clip && plan.clips.includes(current.clip)) {
        const sh = current.entry.shift;
        if (t >= current.clip.start + sh && t < current.clip.end + sh - 0.2) clip = current.clip; // don't hop mid-clip
      }
    }
    if (!clip) {
      debug({ state: inMuted ? "muted-uncovered" : "not-muted", t });
      return stop();
    }

    const st = stateFor(clip);
    if (!current || current.clip !== clip) {
      if (audio) audio.pause();
      current = { clip, entry: st, url: st.url || null }; // preloaded: start this tick
      st.file.then((url) => {
        if (current && current.clip === clip) current.url = url;
      });
    }

    // Collect player frames for matching while the picture is moving.
    if (st.sync === "estimate" && !st.matching && !v.paused && v.readyState >= 2) {
      const last = st.samples[st.samples.length - 1];
      if (!last || t - last.t >= SAMPLE_GAP_S || t < last.t) {
        if (last && t < last.t) st.samples.length = 0; // seeked backwards
        const px = thumb(v);
        if (px) st.samples.push({ t, px });
        else st.sync = "unreadable";
      }
      if (st.samples.length >= SAMPLES) match(clip, st);
    }

    if (!current.url) {
      debug({ state: "loading", kind: clip.kind || "clip", slug: clip.slug, t });
      return;
    }
    const a = player(current.url);
    if (audio !== a) {
      if (audio) audio.pause();
      audio = a;
    }

    audio.volume = v.muted ? 0 : v.volume;
    audio.playbackRate = v.playbackRate || 1;
    const want = t - (clip.start + st.shift);
    if (v.paused || v.seeking || v.readyState < 3) {
      if (!audio.paused) audio.pause();
    } else {
      if (audio.readyState >= 1 && Math.abs(audio.currentTime - want) > MAX_DRIFT) audio.currentTime = want;
      // Before metadata the position can't be set, and play() would start at 0.
      if (audio.paused && audio.readyState >= 1) {
        audio.play().then(
          () => (playError = null),
          (err) => {
            playError = (err && err.name) || String(err);
            if (playError === "NotAllowedError") armUnlock();
          }
        );
      }
    }
    debug({
      state: audio.paused ? "ready" : "playing",
      kind: clip.kind || "clip",
      slug: clip.slug,
      sync: st.sync,
      shift: st.shift,
      score: st.score,
      t: Math.round(t * 100) / 100,
      clipT: Math.round(audio.currentTime * 100) / 100,
      want: Math.round(want * 100) / 100,
      clipStart: clip.start,
      vol: audio.volume,
      playError
    });
  }

  // Debug: localStorage.dmcaUnmuteDebug = "1" mirrors the report onto <html data-dmca-unmute-report>.
  setInterval(() => {
    let on = false;
    try {
      on = localStorage.getItem("dmcaUnmuteDebug") === "1";
    } catch (_) {}
    if (!on) return;
    browser.runtime
      .sendMessage({ type: "getReport", tabId: "self" })
      .then((r) => {
        document.documentElement.dataset.dmcaUnmuteReport = JSON.stringify(r);
      })
      .catch(() => {});
  }, 2000);

  setInterval(tick, TICK_MS);
})();
