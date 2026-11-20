"use strict";

/*
 * Plays clip audio over muted VOD ranges.
 *
 * Twitch's muted segments carry pure silence (-91 dB measured), so there is no
 * double audio: while the player is inside a muted range that a clip covers, a
 * detached <audio> element plays that clip, slaved to the player's time, rate,
 * volume and pause state.
 *
 * Clip start times from the API are only good to about +-0.7 s, which is
 * visibly off for speech. So the first time a clip is used we line it up the
 * way the test harness did: sample small grayscale frames from the player,
 * decode the clip's frames around the estimate, and pick the shift whose
 * frames match best.
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
  let current = null;        // { clip, entry }
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

  let lastSent = "";
  let lastSentAt = 0;
  function debug(state) {
    const json = JSON.stringify(state);
    try {
      document.documentElement.dataset.dmcaUnmute = json;
    } catch (_) {}
    // Live state for the popup: on change of what's happening, or every 2 s.
    const key = [state.state, state.slug, state.sync, state.playError].join("|");
    if (key !== lastSent || Date.now() - lastSentAt > 2000) {
      lastSent = key;
      lastSentAt = Date.now();
      browser.runtime.sendMessage({ type: "clipState", state }).catch(() => {});
    }
  }

  // Firefox may refuse audible play() until the user interacts with the page.
  // Retry on the next click/key instead of staying silent.
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

  /** Keep only the decoded Kick chunks near the playhead (each is ~7 MB). */
  function pruneKick(t) {
    for (const [key, st] of clipState) {
      if (!key.startsWith("kick:")) continue;
      const c = kickClips.get(key);
      if (c && (c.end < t - 60 || c.start > t + 300)) {
        clipState.delete(key);
        kickClips.delete(key);
        if (st.file) st.file.then((url) => url && (!current || current.url !== url) && URL.revokeObjectURL(url));
      }
    }
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

  function tick() {
    refreshPlan();
    const v = mainVideo();
    if (!v || !plan || ((!plan.clips || plan.clips.length === 0) && !plan.kick)) {
      debug({ state: plan ? "no-clips" : "no-plan" });
      return stop();
    }

    const t = v.currentTime;
    const range = plan.ranges.find((r) => t >= r.start && t < r.end);
    const inMuted = !!range;
    let clip = null;
    if (inMuted && plan.kick) {
      // Full audio from Kick's copy of the stream, cut into chunks.
      clip = kickClip(range, t, plan.kick.chunk);
      if (clip && clip.end - t < 25 && clip.end < range.end) stateFor(kickClip(range, clip.end, plan.kick.chunk));
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
      current = { clip, entry: st, url: null };
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
    if (!audio) {
      audio = new Audio();
      audio.preload = "auto";
    }
    if (audio.dataset.src !== current.url) {
      audio.src = current.url;
      audio.dataset.src = current.url;
    }

    audio.volume = v.muted ? 0 : v.volume;
    audio.playbackRate = v.playbackRate || 1;
    const want = t - (clip.start + st.shift);
    if (v.paused || v.seeking || v.readyState < 3) {
      if (!audio.paused) audio.pause();
    } else {
      if (audio.readyState >= 1 && Math.abs(audio.currentTime - want) > MAX_DRIFT) audio.currentTime = want;
      if (audio.paused) {
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

  // Opt-in debug: localStorage.dmcaUnmuteDebug = "1" mirrors the popup's report
  // onto <html data-dmca-unmute-report>, so it can be inspected without the popup.
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
