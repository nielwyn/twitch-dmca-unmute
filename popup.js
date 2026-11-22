"use strict";

const $ = (id) => document.getElementById(id);
let lastDiagText = "";

function setStatus(parts) {
  const el = $("status");
  el.textContent = "";
  for (const part of parts) {
    if (typeof part === "string") {
      el.append(part);
      continue;
    }
    const b = document.createElement("b");
    if (part.cls) b.className = part.cls;
    b.textContent = part.text;
    el.append(b);
  }
}

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const mb = (bytes) => (bytes / 1048576).toFixed(bytes > 104857600 ? 0 : 1) + " MB";

function renderRanges(report) {
  const list = $("ranges");
  list.textContent = "";
  const gaveUp = /deleted/.test(report.note || ""); // background stopped trying: originals purged
  for (const range of report.ranges) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = `${range.start} – ${range.end}`;
    const tag = document.createElement("span");
    if (range.cached === range.total) {
      tag.className = "tag ok";
      tag.textContent = "audio secured";
    } else if (report.kick) {
      tag.className = "tag ok";
      tag.textContent = "full audio (Kick)";
    } else if (range.cached + range.missing < range.total && !gaveUp) {
      // Originals are fetched only near the playhead, so untouched ranges wait.
      tag.className = "tag pending";
      tag.textContent = range.cached ? `fetched ${range.cached}/${range.total}` : "fetched when watched";
    } else if (range.cached > 0) {
      tag.className = "tag partial";
      tag.textContent = `partial ${range.cached}/${range.total}`;
    } else if (range.clipSec > 0) {
      const whole = range.clipSec >= (range.endSec - range.id) - 1;
      tag.className = whole ? "tag ok" : "tag partial";
      tag.textContent = whole ? "clip audio" : `clip audio ${range.clipSec}s`;
    } else {
      tag.className = "tag bad";
      tag.textContent = report.clipStatus === "ok" ? "gone · no clips" : "gone";
    }
    li.append(span, tag);
    list.append(li);
  }
}

async function render() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const { settings, report, diag, counters, queued, active, notes } = await browser.runtime.sendMessage({
    type: "getReport",
    tabId: tab.id
  });

  for (const key of ["enabled", "crossQuality", "prefetchAll"]) $(key).checked = settings[key];

  $("counters").textContent =
    `playlists ${counters.playlists} · muted ${counters.mutedSegments} · cached ${counters.cached} ` +
    `· gone ${counters.missing} · injected ${counters.injected} ` +
    `· clip plays ${counters.clipPlays} · kick chunks ${counters.kickChunks} · cross-quality ${counters.crossQuality} ` +
    `· ${mb(counters.bytes)} · queue ${queued}, ${active} active`;
  lastDiagText =
    (notes.length ? "FAILURES\n" + notes.join("\n") + "\n\n" : "") +
    (diag.map((d) => `${d.action}  ${d.host}${d.path}`).join("\n") || "(nothing seen yet)");
  $("diag").textContent = lastDiagText;
  $("why").textContent = notes.length ? notes.slice(0, 3).join(" · ") : "";
  $("why").classList.toggle("hidden", notes.length === 0);

  if (!settings.enabled) return setStatus(["Disabled."]);
  if (!report) {
    return setStatus([
      "No Twitch VOD traffic seen in this tab yet. Hard-reload the VOD page (Ctrl+Shift+R) with the player open."
    ]);
  }

  renderRanges(report);

  if (report.ranges.length > 0) {
    setStatus([
      "Audio secured for ",
      { text: `${report.cachedSegments}/${report.mutedSegments}`, cls: "ok" },
      " muted segments",
      queued + active > 0 ? ` · ${queued + active} downloading near where you're watching` : "",
      report.injected ? ` · ${report.injected} played back unmuted` : ""
    ]);
    const c = report.clipInfo;
    let clipLine;
    if (report.kick) {
      clipLine =
        `Full audio: this stream's copy on Kick is unmuted and covers every muted part ` +
        `(offset ${report.kick.delta.toFixed(2)}s, match r=${report.kick.r.toFixed(2)}).`;
    } else if (c && report.clipStatus === "ok") {
      clipLine =
        `Clip audio: ${c.useful} of ${c.found} clips from this VOD overlap muted parts, ` +
        `covering ${c.covered}s of ${c.muted}s muted.`;
    } else if (report.clipStatus === "searching") {
      clipLine = "Clip audio: searching this VOD's clips…";
    } else if (report.clipStatus) {
      clipLine = `Clip audio failed — ${report.clipStatus}`;
    } else {
      clipLine = "Clip audio: page script not running — reload the VOD tab (Ctrl+Shift+R).";
    }
    if (report.kick) {
      setStatus(["Twitch deleted the originals, but the muted parts are restored from Kick's copy of this stream."]);
      $("why").classList.add("hidden"); // segment 403s are irrelevant now; still listed under Diagnostics
    } else if (report.note) {
      setStatus([report.note]);
    }
    const live = report.live && Date.now() - report.live.at < 5000 ? report.live : null;
    if (live) {
      const at = live.t != null ? fmt(live.t) + " — " : "";
      let what = {
        playing:
          live.kind === "kick"
            ? "playing full audio from Kick"
            : `playing clip audio (sync ${live.sync}${live.shift ? ", " + live.shift + "s" : ""})`,
        ready: "clip audio ready, player paused",
        loading: live.kind === "kick" ? "loading Kick audio…" : "loading clip audio…",
        "muted-uncovered": "muted part with no clip — silence is all Twitch has",
        "not-muted": "not in a muted part (original audio)",
        original: "muted part, but Twitch's original audio was restored here",
        "no-clips": "no usable clips for this VOD",
        "no-plan": "waiting for clip search…"
      }[live.state] || live.state;
      if (live.playError && live.state === "ready") what = "clip audio NOT playing";
      clipLine += `\nNow: ${at}${what}`;
      if (live.playError === "NotAllowedError") clipLine += "\n⚠ Firefox blocked clip audio — click the player once to allow it.";
      else if (live.playError) clipLine += `\n⚠ clip audio error: ${live.playError}`;
      if (live.state === "playing" && live.vol === 0) clipLine += "\n⚠ the player is muted or at 0 volume.";
    } else {
      clipLine += "\nNow: no live state from the page — reload the VOD tab.";
    }
    $("clips").textContent = clipLine;
    $("clips").style.whiteSpace = "pre-line";
    $("clips").classList.remove("hidden");
  } else {
    setStatus([report.note || "No muted sections found in this VOD."]);
  }

  if (report.ageHours != null) {
    const h = report.ageHours;
    $("age").textContent =
      `VOD aired ${h < 1 ? Math.round(h * 60) + " min" : h.toFixed(1) + " h"} ago` +
      (h > 24 ? " — past the ~24 h window; most originals are already deleted." : " — inside the recovery window.");
    $("age").classList.remove("hidden");
  }
}

for (const key of ["enabled", "crossQuality", "prefetchAll"]) {
  $(key).addEventListener("change", (e) =>
    browser.runtime.sendMessage({ type: "setSetting", key, value: e.target.checked }).then(render)
  );
}

$("reload").addEventListener("click", async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  await browser.runtime.sendMessage({ type: "reset", tabId: tab.id });
  await browser.tabs.reload({ bypassCache: true });
  window.close();
});

$("copy").addEventListener("click", () => {
  navigator.clipboard.writeText(lastDiagText).then(() => {
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy diagnostics"), 1200);
  });
});

$("retry").addEventListener("click", async () => {
  const n = await browser.runtime.sendMessage({ type: "retry" });
  $("retry").textContent = `Retrying ${n}`;
  setTimeout(() => ($("retry").textContent = "Retry failed segments"), 1500);
  render();
});

$("clear").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "clearCache" });
  $("clear").textContent = "Cleared";
  setTimeout(() => ($("clear").textContent = "Clear cached audio"), 1200);
  render();
});

render();
setInterval(render, 2000);
