"use strict";

/*
 * Twitch DMCA Unmute. The playlist is left as-is; responses for muted segments
 * get their body swapped for the downloaded original. Once originals are gone,
 * content.js plays Kick or clip audio over the muted ranges instead.
 */

const DEFAULTS = {
  enabled: true,
  crossQuality: true,
  prefetchAll: false // true = grab every muted original at once; false = only near the playhead
};
const settings = Object.assign({}, DEFAULTS);

const IS_PLAYLIST = /\.m3u8(\?|$|\/)/i;
const IS_SEGMENT = /\.(ts|mp4|m4s|m4v|aac)(\?|$)/i;
const IS_MUTED_URL = /-muted\.(?:ts|mp4|m4s|m4v|aac)(?:\?|$)/i;
const MUTED_SEGMENT = /^(.*?)-muted(\.(?:ts|mp4|m4s|m4v|aac)(?:\?.*)?)$/;
const MUTED_PLAYLIST_NAME = /-muted-\w+(?=\.m3u8)/;
const AIR_DATE = /#ID3-EQUIV-TDTG:(.+)/;

const VOD_HOST = /(^|\.)(cloudfront\.net|ttvnw\.net|twitch\.tv|akamaized\.net|llnwd\.net|fastly\.net|edgecastcdn\.net)$/i;

const FETCH_TIMEOUT_MS = 8000;
const ACQUIRE_WAIT_MS = 10000;   // how long a segment response may be held
const PREFETCH_WORKERS = 12;
const MEM_LIMIT_BYTES = 400 * 1048576;
const MIN_SEGMENT_BYTES = 2048;
const DIAG_MAX = 80;

browser.storage.local.get(DEFAULTS).then((stored) => Object.assign(settings, stored));
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in settings) settings[key] = newValue;
  }
});

/** mutedUrl -> ArrayBuffer. The real store; IndexedDB is best-effort persistence. */
const mem = new Map();
let memBytes = 0;

function memPut(url, buf) {
  if (mem.has(url)) return;
  mem.set(url, buf);
  memBytes += buf.byteLength;
  while (memBytes > MEM_LIMIT_BYTES && mem.size > 1) {
    const oldest = mem.keys().next().value;
    const dropped = mem.get(oldest);
    mem.delete(oldest);
    memBytes -= dropped.byteLength;
  }
}

/** First few occurrences of each failure kind, so the popup can explain itself. */
const notes = new Map();
function note(kind, url) {
  const seen = notes.get(kind) || 0;
  notes.set(kind, seen + 1);
  if (seen < 3) log(kind, url);
}

/** mutedUrl -> { status: "pending"|"have"|"miss", len, source, promise } */
const cacheIndex = new Map();
/** mutedUrl -> { tabId, rangeId } so progress lands on the right range. */
const owner = new Map();
/** vodKey -> quality directory names from the master playlist. */
const qualities = new Map();
/** tabId -> popup report. */
const tabReports = new Map();

const queue = [];
let activeWorkers = 0;

// Stop downloading a VOD once its first originals all fail (purged).
const GIVE_UP_AFTER = 24;
/** vodKey -> { ok, fail, dead } */
const vodStats = new Map();
function statsFor(url) {
  const key = vodKeyFor(url);
  let st = vodStats.get(key);
  if (!st) vodStats.set(key, (st = { ok: 0, fail: 0, dead: false }));
  return st;
}

/** Range rescue costs 1-2 extra requests per segment; stop once it's clearly futile. */
let rangeWins = 0;
let rangeLosses = 0;

const diag = [];
const counters = {
  playlists: 0, sniffed: 0,
  mutedSegments: 0, cached: 0, missing: 0, injected: 0, crossQuality: 0,
  bytes: 0, clipPlays: 0, kickChunks: 0
};

/* ------------------------------------------------------------------ utils */

function log(action, url) {
  let host = url || "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.host;
    path = u.pathname;
  } catch (_) {}
  diag.push({ t: Date.now(), action, host, path: path.length > 70 ? "…" + path.slice(-70) : path });
  if (diag.length > DIAG_MAX) diag.shift();
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function vodKeyFor(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.split("/").slice(0, -2).join("/");
  } catch (_) {
    return url;
  }
}

function altSegmentUrls(absUrl) {
  try {
    const u = new URL(absUrl);
    const parts = u.pathname.split("/");
    const qIndex = parts.length - 2;
    const list = qualities.get(u.origin + parts.slice(0, qIndex).join("/"));
    if (!list) return [];
    return list
      .filter((q) => q !== parts[qIndex])
      .map((q) => {
        const copy = parts.slice();
        copy[qIndex] = q;
        return u.origin + copy.join("/") + u.search;
      });
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------- byte store */

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("twitch-dmca-unmute", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("seg")) d.createObjectStore("seg");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function idbRun(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction("seg", mode);
        const req = fn(tx.objectStore("seg"));
        tx.onerror = () => reject(tx.error);
        if (req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          tx.oncomplete = () => resolve();
        }
      })
  );
}

const idbGet = (key) => idbRun("readonly", (s) => s.get(key));
const idbPut = (key, value) => idbRun("readwrite", (s) => s.put(value, key));
const idbKeys = () => idbRun("readonly", (s) => s.getAllKeys());
const idbDelete = (key) => idbRun("readwrite", (s) => s.delete(key));

async function pruneCache(maxAgeHours = 12) {
  try {
    const keys = await idbKeys();
    const cutoff = Date.now() - maxAgeHours * 3600000;
    let removed = 0;
    for (const key of keys) {
      const rec = await idbGet(key);
      if (!rec || rec.t < cutoff) {
        await idbDelete(key);
        cacheIndex.delete(key);
        removed++;
      }
    }
    if (removed) log(`cache:pruned ${removed}`, "");
  } catch (_) {}
}
pruneCache();

async function clearCache() {
  try {
    await idbRun("readwrite", (s) => s.clear());
  } catch (_) {}
  cacheIndex.clear();
  mem.clear();
  memBytes = 0;
  counters.cached = 0;
  counters.missing = 0;
  counters.bytes = 0;
}

/* ----------------------------------------------------- acquiring the bytes */

function timedFetch(url, withCookies, range) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const init = {
    credentials: withCookies ? "include" : "omit",
    cache: "no-store",
    signal: controller.signal
  };
  if (range) init.headers = { Range: range };
  return fetch(url, init).finally(() => clearTimeout(timer));
}

// A CDN can still serve byte ranges of an object whose full GET is 403.
const RANGE_CHUNK = 262144;

async function rangedFetch(url, withCookies) {
  if (rangeWins === 0 && rangeLosses >= 20) return null;
  let head;
  try {
    head = await timedFetch(url, withCookies, "bytes=0-1");
  } catch (err) {
    note("range:" + ((err && err.name) || "error"), url);
    return null;
  }
  if (head.status !== 206) {
    rangeLosses++;
    note("range:HTTP " + head.status + " (object really is gone)", url);
    return null;
  }
  rangeWins++;

  const contentRange = head.headers && head.headers.get ? head.headers.get("content-range") : null;
  const total = contentRange ? parseInt(String(contentRange).split("/")[1], 10) : NaN;
  if (!Number.isFinite(total) || total < MIN_SEGMENT_BYTES) {
    note("range:206 but no usable Content-Range", url);
    return null;
  }
  note("range:206 while full GET is 403 - reassembling " + total + "B", url);

  // One whole-object range first; fall back to chunks if that is refused.
  try {
    const whole = await timedFetch(url, withCookies, `bytes=0-${total - 1}`);
    if (whole.status === 206 || whole.status === 200) {
      const buf = await whole.arrayBuffer();
      if (buf.byteLength === total) {
        note("range:reassembled in one request", url);
        return buf;
      }
    }
  } catch (_) {
    /* fall through to chunked */
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (let start = 0; start < total; start += RANGE_CHUNK) {
    const end = Math.min(total - 1, start + RANGE_CHUNK - 1);
    let part;
    try {
      part = await timedFetch(url, withCookies, `bytes=${start}-${end}`);
    } catch (err) {
      note("range:chunk " + ((err && err.name) || "error"), url);
      return null;
    }
    if (part.status !== 206) {
      note("range:chunk HTTP " + part.status + " (partial object only)", url);
      return null;
    }
    const bytes = new Uint8Array(await part.arrayBuffer());
    out.set(bytes, offset);
    offset += bytes.length;
  }
  if (offset !== total) {
    note("range:short read " + offset + "/" + total, url);
    return null;
  }
  note("range:reassembled from " + Math.ceil(total / RANGE_CHUNK) + " chunks", url);
  return out.buffer;
}

// Retry the first few 403s with cookies, in case they make a difference.
let useCookies = false;
let cookieTrials = 0;

/** Returns the original segment's bytes, or null if they cannot be had. */
async function getOriginalBytes(url) {
  const res = await timedFetch(url, useCookies);
  if (res.ok) return res.arrayBuffer();

  if (res.status === 403 && !useCookies && cookieTrials < 5) {
    cookieTrials++;
    try {
      const retry = await timedFetch(url, true);
      if (retry.ok) {
        useCookies = true;
        note("fetch:403 WITHOUT cookies but OK WITH them - switching", url);
        return retry.arrayBuffer();
      }
      note("fetch:403 with cookies too", url);
    } catch (err) {
      note("fetch:403, cookie retry " + ((err && err.name) || "failed"), url);
    }
  } else {
    note("fetch:HTTP " + res.status, url);
  }

  if (res.status === 403 || res.status === 404) return rangedFetch(url, useCookies);
  return null;
}

function candidatesFor(mutedUrl) {
  const match = MUTED_SEGMENT.exec(mutedUrl);
  if (!match) return [];
  // .ts VODs keep the original as N.ts, fMP4 VODs as N-unmuted.mp4.
  const plain = match[1] + match[2];
  const unmuted = match[1] + "-unmuted" + match[2];
  const fmp4 = /^\.(mp4|m4s|m4v)/.test(match[2]);
  const own = fmp4 ? [unmuted, plain] : [plain, unmuted];
  return settings.crossQuality ? own.concat(altSegmentUrls(own[0]).slice(0, 2)) : own;
}

/** Download and keep the original for a muted segment (concurrent calls share one download). */
function acquire(mutedUrl) {
  const existing = cacheIndex.get(mutedUrl);
  if (existing) return existing.promise || Promise.resolve(existing);

  const entry = { status: "pending", len: 0, source: null };
  entry.promise = (async () => {
    const have = mem.get(mutedUrl) || (await idbGet(mutedUrl).catch((e) => {
      note("idb:read-error " + (e && e.name), mutedUrl);
      return null;
    }).then((rec) => (rec && rec.b) || null));
    if (have && have.byteLength >= MIN_SEGMENT_BYTES) {
      memPut(mutedUrl, have);
      entry.status = "have";
      entry.len = have.byteLength;
      counters.cached++;
      bump(mutedUrl, "have");
      return entry;
    }

    const st = statsFor(mutedUrl);
    if (st.dead) {
      entry.status = "miss";
      counters.missing++;
      bump(mutedUrl, "miss");
      return entry;
    }

    const keep = (url, buf) => {
      st.ok++;
      memPut(mutedUrl, buf);              // usable immediately, IDB or not
      entry.status = "have";
      entry.len = buf.byteLength;
      entry.source = url;
      counters.cached++;
      counters.bytes += buf.byteLength;
      bump(mutedUrl, "have");
      idbPut(mutedUrl, { b: buf, t: Date.now(), src: url, vod: vodKeyFor(mutedUrl) }).catch((e) =>
        note("idb:write-error " + (e && e.name), mutedUrl)
      );
      return entry;
    };

    const candidates = candidatesFor(mutedUrl);
    if (candidates.length === 0) note("bug:no-candidate-url", mutedUrl);
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      let buf;
      try {
        buf = await getOriginalBytes(url);
      } catch (err) {
        note("fetch:" + ((err && err.name) || "error"), url);
        continue;
      }
      if (!buf) continue;
      if (buf.byteLength < MIN_SEGMENT_BYTES) {
        note("fetch:too-small", url);
        continue;
      }
      if (i > 0) counters.crossQuality++;
      return keep(url, buf);
    }

    st.fail++;
    if (!st.dead && st.ok === 0 && st.fail >= GIVE_UP_AFTER) {
      st.dead = true;
      note(`vod:first ${st.fail} originals all gone - purged, stopped downloading`, mutedUrl);
      for (const [, where] of owner) {
        const report = tabReports.get(where.tabId);
        if (report && report.key === vodKeyFor(mutedUrl)) {
          report.note = "Twitch has deleted the unmuted originals of this VOD. Using clip audio where clips exist.";
        }
      }
    }
    entry.status = "miss";
    counters.missing++;
    bump(mutedUrl, "miss");
    return entry;
  })().catch((err) => {
    note("acquire:crash " + ((err && err.message) || err), mutedUrl);
    entry.status = "miss";
    counters.missing++;
    bump(mutedUrl, "miss");
    return entry;
  }).finally(() => {
    entry.promise = null;
  });

  cacheIndex.set(mutedUrl, entry);
  return entry.promise;
}

/** Wait for an acquisition, but never hold a response for too long. */
async function acquireBounded(mutedUrl) {
  const entry = cacheIndex.get(mutedUrl);
  if (entry && entry.status !== "pending") return entry;
  let timer;
  const bail = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout", len: 0 }), ACQUIRE_WAIT_MS);
  });
  try {
    return await Promise.race([acquire(mutedUrl), bail]);
  } finally {
    clearTimeout(timer);
  }
}

function pump() {
  while (activeWorkers < PREFETCH_WORKERS && queue.length) {
    const url = queue.shift();
    if (cacheIndex.has(url)) continue;
    activeWorkers++;
    acquire(url).finally(() => {
      activeWorkers--;
      pump();
    });
  }
}

const NEAR_BEHIND_S = 10;
const NEAR_AHEAD_S = 300;
let nearKey = "";

/** Queue the originals from 10 s behind to 5 min ahead of the playhead; a seek resets it. */
function prefetchNear(tabId, t) {
  const report = tabReports.get(tabId);
  if (!report || settings.prefetchAll) return;
  const near = [];
  for (const row of report.ranges) {
    if (!row.times || row.endSec < t - NEAR_BEHIND_S || row.id > t + NEAR_AHEAD_S) continue;
    row.urls.forEach((u, i) => {
      const at = row.times[i];
      if (at + 10 >= t - NEAR_BEHIND_S && at <= t + NEAR_AHEAD_S && !cacheIndex.has(u)) near.push([at, u]);
    });
  }
  near.sort((a, b) => a[0] - b[0]);
  const key = near.map((x) => x[1]).join();
  if (key === nearKey) return pump();
  nearKey = key;
  queue.length = 0;
  for (const [, u] of near) queue.push(u);
  pump();
}

function enqueue(urls) {
  for (const url of urls) if (!cacheIndex.has(url)) queue.push(url);
  pump();
}

/** Record per-range progress so the popup reflects bytes actually in hand. */
function bump(mutedUrl, kind) {
  const where = owner.get(mutedUrl);
  if (!where) return;
  const report = tabReports.get(where.tabId);
  if (!report) return;
  const range = report.ranges.find((r) => r.id === where.rangeId);
  if (!range) return;
  if (kind === "injected") {
    range.injected++;
  } else if (range.urls && range.urls.length) {
    // Derive from the index so a re-parse or a double settle can't skew it.
    range.cached = range.urls.filter((u) => (cacheIndex.get(u) || {}).status === "have").length;
    range.missing = range.urls.filter((u) => (cacheIndex.get(u) || {}).status === "miss").length;
  } else if (kind === "have") {
    range.cached++;
  } else if (kind === "miss") {
    range.missing++;
  }
  recount(where.tabId, report);
}

function recount(tabId, report) {
  report.cachedSegments = report.ranges.reduce((n, r) => n + r.cached, 0);
  report.missingSegments = report.ranges.reduce((n, r) => n + r.missing, 0);
  report.inFlight = queue.length + activeWorkers;
  report.fullRanges = report.ranges.filter((r) => r.cached === r.total).length;
  report.partialRanges = report.ranges.filter((r) => r.cached > 0 && r.cached < r.total).length;
  setBadge(tabId, report);
}

/* ------------------------------------------------------------- reporting */

function emptyReport() {
  return {
    key: null,
    ranges: [],
    mutedSegments: 0,
    cachedSegments: 0,
    fullRanges: 0,
    partialRanges: 0,
    injected: 0,
    ageHours: null,
    note: null,
    sawPlaylist: false
  };
}

function reportFor(tabId) {
  let report = tabReports.get(tabId);
  if (!report) {
    report = emptyReport();
    tabReports.set(tabId, report);
  }
  return report;
}

function setBadge(tabId, report) {
  if (tabId < 0) return;
  let text = "";
  let color = "#00a862";
  if (report.ranges.length > 0) {
    text = String(report.fullRanges + report.partialRanges);
    if (report.partialRanges > 0) color = "#c78b16";
    if (report.fullRanges + report.partialRanges === 0) {
      text = "✕";
      color = "#d14343";
    }
  }
  browser.browserAction.setBadgeText({ tabId, text });
  browser.browserAction.setBadgeBackgroundColor({ tabId, color });
}

/* -------------------------------------------------------------- playlists */

function recordQualities(body, playlistUrl) {
  if (!body.includes("#EXT-X-STREAM-INF")) return false;
  let expectUrl = false;
  let count = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      expectUrl = true;
      continue;
    }
    if (!expectUrl || !line || line.startsWith("#")) continue;
    expectUrl = false;
    let abs;
    try {
      abs = new URL(line, playlistUrl);
    } catch (_) {
      continue;
    }
    const parts = abs.pathname.split("/");
    if (parts.length < 3) continue;
    const key = abs.origin + parts.slice(0, -2).join("/");
    const list = qualities.get(key) || [];
    const quality = parts[parts.length - 2];
    if (!list.includes(quality)) list.push(quality);
    qualities.set(key, list);
    count++;
  }
  if (count) log(`master:${count} renditions`, playlistUrl);
  return count > 0;
}

async function fetchPreMutePlaylist(playlistUrl, body) {
  const altUrl = playlistUrl.replace(MUTED_PLAYLIST_NAME, "");
  if (altUrl === playlistUrl) return null;
  try {
    const res = await timedFetch(altUrl, false);
    if (!res.ok) return null;
    const alt = await res.text();
    if (!alt.startsWith("#EXTM3U") || alt.includes("-muted")) return null;
    const count = (s) => (s.match(/^[^#\s].*$/gm) || []).length;
    if (count(alt) !== count(body)) return null;
    return alt;
  } catch (_) {
    return null;
  }
}

function parseSegments(lines) {
  const segments = [];
  let elapsed = 0;
  let duration = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice("#EXTINF:".length)) || 0;
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    segments.push({ index: i, path: line, muted: MUTED_SEGMENT.test(line), start: elapsed, duration });
    elapsed += duration;
    duration = 0;
  }
  return segments;
}

function groupMutedRanges(segments) {
  const ranges = [];
  let current = null;
  for (const seg of segments) {
    if (!seg.muted) {
      current = null;
      continue;
    }
    if (!current) {
      current = { start: seg.start, end: seg.start + seg.duration, segments: [seg] };
      ranges.push(current);
    } else {
      current.end = seg.start + seg.duration;
      current.segments.push(seg);
    }
  }
  return ranges;
}

/** Returns the playlist unchanged; records the muted ranges and queues downloads. */
async function processPlaylist(body, playlistUrl, tabId) {
  const report = reportFor(tabId);
  counters.playlists++;

  if (recordQualities(body, playlistUrl)) return body;

  report.sawPlaylist = true;

  if (MUTED_PLAYLIST_NAME.test(playlistUrl)) {
    const preMute = await fetchPreMutePlaylist(playlistUrl, body);
    if (preMute) {
      report.note = "Served the pre-mute playlist for this highlight.";
      log("playlist:pre-mute", playlistUrl);
      return preMute;
    }
  }

  if (!body.includes("-muted")) {
    if (report.ranges.length === 0) report.note = "Playlist has no muted segments.";
    setBadge(tabId, report);
    log("playlist:clean", playlistUrl);
    return body;
  }

  const parsed = parseSegments(body.split("\n"));
  vodPlaylists.set(vodKeyFor(playlistUrl), { url: playlistUrl, segs: parsed });
  const ranges = groupMutedRanges(parsed);
  if (ranges.length === 0) return body;

  const airMatch = AIR_DATE.exec(body);
  const airedAt = airMatch ? Date.parse(airMatch[1].trim()) : NaN;
  if (!Number.isNaN(airedAt)) report.ageHours = (Date.now() - airedAt) / 3600000;

  const key = vodKeyFor(playlistUrl);
  const fresh = report.key !== key;
  if (fresh) {
    report.key = key;
    report.ranges = [];
    report.injected = 0;
  }

  const wanted = [];
  for (const range of ranges) {
    const id = range.start;
    let row = report.ranges.find((r) => r.id === id);
    if (!row) {
      row = {
        id,
        start: formatTime(range.start),
        end: formatTime(range.end),
        endSec: range.end,
        total: range.segments.length,
        cached: 0,
        missing: 0,
        injected: 0,
        urls: [],
        times: [],
        durs: []
      };
      report.ranges.push(row);
    }
    row.urls = [];
    row.times = [];
    row.durs = [];
    for (const seg of range.segments) {
      const abs = new URL(seg.path, playlistUrl).href;
      owner.set(abs, { tabId, rangeId: id }); // always claim it, even if seen earlier
      row.urls.push(abs);
      row.times.push(seg.start);
      row.durs.push(seg.duration);
      wanted.push(abs);
    }
    // Count downloads that finished before this row existed.
    row.cached = row.urls.filter((u) => (cacheIndex.get(u) || {}).status === "have").length;
    row.missing = row.urls.filter((u) => (cacheIndex.get(u) || {}).status === "miss").length;
  }
  report.ranges.sort((a, b) => a.id - b.id);
  report.mutedSegments = report.ranges.reduce((n, r) => n + r.total, 0);
  counters.mutedSegments = report.mutedSegments;
  report.note = null;
  recount(tabId, report);

  if (settings.prefetchAll) {
    enqueue(wanted);
    log(`playlist:${ranges.length} muted ranges, fetching all ${wanted.length} originals`, playlistUrl);
  } else {
    if (report.live && typeof report.live.t === "number") prefetchNear(tabId, report.live.t);
    log(`playlist:${ranges.length} muted ranges, fetching originals near the playhead`, playlistUrl);
  }

  return body;
}

/* ------------------------------------------------- text filter (playlists) */

function attachTextFilter(details, transform, { sniff }) {
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(details.requestId);
  } catch (_) {
    return;
  }
  const chunks = [];
  let passthrough = false;

  filter.ondata = (event) => {
    if (sniff && chunks.length === 0 && !passthrough) {
      const head = new TextDecoder("utf-8", { fatal: false }).decode(event.data.slice(0, 8));
      if (!head.startsWith("#EXTM3U")) {
        passthrough = true;
        filter.write(event.data);
        filter.disconnect();
        return;
      }
      counters.sniffed++;
    }
    if (passthrough) {
      filter.write(event.data);
      return;
    }
    chunks.push(new Uint8Array(event.data));
  };
  filter.onerror = () => {};
  filter.onstop = async () => {
    if (passthrough) {
      filter.close();
      return;
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) {
      filter.close();
      return;
    }
    const raw = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      const text = new TextDecoder("utf-8").decode(raw);
      const out = await transform(text, details);
      filter.write(out === text ? raw : new TextEncoder().encode(out));
    } catch (_) {
      filter.write(raw);
    }
    filter.close();
  };
}

/* ------------------------------------------- byte injection (the segments) */

/** Record which seconds now have Twitch's real audio, so content.js doesn't play over them. */
function markReal(report, url) {
  const name = "/" + new URL(url).pathname.split("/").pop();
  for (const row of report.ranges) {
    const i = (row.urls || []).findIndex((u) => u.endsWith(name));
    if (i < 0 || !row.times) continue;
    const span = [row.times[i], row.times[i] + row.durs[i]];
    report.real = report.real || [];
    if (!report.real.some((r) => r[0] === span[0])) report.real.push(span);
    return;
  }
}

function injectSegment(details) {
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(details.requestId);
  } catch (_) {
    return;
  }
  const original = [];
  filter.ondata = (event) => original.push(new Uint8Array(event.data));
  filter.onerror = () => {};
  filter.onstop = async () => {
    try {
      const entry = await acquireBounded(details.url);
      if (entry && entry.status === "have") {
        let bytes = mem.get(details.url);
        if (!bytes) {
          const record = await idbGet(details.url).catch(() => null);
          bytes = record && record.b;
        }
        if (bytes && bytes.byteLength >= MIN_SEGMENT_BYTES) {
          filter.write(bytes);
          filter.close();
          counters.injected++;
          const report = tabReports.get(details.tabId);
          if (report) {
            report.injected++;
            bump(details.url, "injected");
            markReal(report, details.url);
          }
          return;
        }
      }
    } catch (_) {
      /* fall through to the silent original */
    }
    for (const chunk of original) filter.write(chunk);
    filter.close();
  };
}

/* --------------------------------------------------------------- listeners */

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!settings.enabled) return;
    if (details.tabId < 0) return; // our own downloads
    const url = details.url;
    if (!url.startsWith("http")) return;

    let host;
    try {
      host = new URL(url).host;
    } catch (_) {
      return;
    }

    if (IS_PLAYLIST.test(url)) {
      attachTextFilter(details, (text, d) => processPlaylist(text, d.url, d.tabId), { sniff: false });
      return;
    }

    if (VOD_HOST.test(host) && IS_MUTED_URL.test(url)) {
      if (!owner.has(url)) owner.set(url, { tabId: details.tabId, rangeId: null });
      acquire(url); // demand-fetch if the prefetcher hasn't reached it yet
      injectSegment(details);
      return;
    }

    if (
      VOD_HOST.test(host) &&
      details.type === "xmlhttprequest" &&
      !IS_SEGMENT.test(url) &&
      !/\.(js|css|png|jpe?g|webp|gif|svg|woff2?|json)(\?|$)/i.test(url)
    ) {
      attachTextFilter(details, (text, d) => processPlaylist(text, d.url, d.tabId), { sniff: true });
    }
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

// A range request would make the injected length wrong; ask for the whole file.
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!settings.enabled) return;
    if (details.tabId < 0) return;
    if (!IS_MUTED_URL.test(details.url)) return;
    const headers = details.requestHeaders.filter((h) => h.name.toLowerCase() !== "range");
    return headers.length === details.requestHeaders.length ? undefined : { requestHeaders: headers };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);

// Content-Length must describe the bytes we are about to substitute.
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!settings.enabled || details.tabId < 0) return;
    if (!IS_MUTED_URL.test(details.url)) return;
    return acquireBounded(details.url).then((entry) => {
      if (!entry || entry.status !== "have" || !entry.len) return {};
      const headers = details.responseHeaders.filter(
        (h) => !/^(content-length|content-range|etag|content-md5)$/i.test(h.name)
      );
      headers.push({ name: "Content-Length", value: String(entry.len) });
      headers.push({ name: "Accept-Ranges", value: "none" });
      return { responseHeaders: headers };
    });
  },
  { urls: ["<all_urls>"] },
  ["blocking", "responseHeaders"]
);

browser.tabs.onRemoved.addListener((tabId) => tabReports.delete(tabId));

/* ------------------------------------------- clips: a second audio source */

// Clips keep their audio; content.js plays the ones that overlap muted ranges.
const GQL_URL = "https://gql.twitch.tv/gql";
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // Twitch's public web client
const CLIP_TOKEN_HASH = "36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11";

async function gqlPost(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(GQL_URL, {
      method: "POST",
      headers: { "Client-Id": GQL_CLIENT_ID, "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal
    });
    if (!res.ok) throw new Error("gql HTTP " + res.status);
    const json = await res.json();
    const first = Array.isArray(json) ? json[0] : json;
    if (first && first.errors && first.errors.length) throw new Error("gql " + first.errors[0].message);
    return first;
  } finally {
    clearTimeout(timer);
  }
}

// Paging with `after:` fails GQL's integrity check, so several cursor-less
// queries are combined; CREATED_AT_* sorts error out. videoOffsetSeconds is
// where the clip ENDS.
const CLIP_QUERIES = [
  ["VIEWS_DESC", "LAST_DAY"], ["VIEWS_DESC", "LAST_WEEK"], ["VIEWS_DESC", "LAST_MONTH"], ["VIEWS_DESC", "ALL_TIME"],
  ["TRENDING", "LAST_DAY"], ["TRENDING", "LAST_WEEK"], ["TRENDING", "LAST_MONTH"], ["TRENDING", "ALL_TIME"]
];
const CLIP_START_BIAS = 0.9;

/** videoId -> Promise<{ clips: [{slug, start, end}], muted: [{start, end}] }> */
const clipLists = new Map();

function clipsFor(videoId) {
  if (clipLists.has(videoId)) return clipLists.get(videoId);
  const job = (async () => {
    const v = await gqlPost({
      query: `query{video(id:"${videoId}"){owner{login} muteInfo{mutedSegmentConnection{nodes{offset duration}}}}}`
    });
    const video = v && v.data && v.data.video;
    const login = video && video.owner && video.owner.login;
    if (!login || !/^\w+$/.test(login)) throw new Error("video owner not found");
    const nodes = (video.muteInfo && video.muteInfo.mutedSegmentConnection && video.muteInfo.mutedSegmentConnection.nodes) || [];
    const muted = nodes.map((n) => ({ start: n.offset, end: n.offset + n.duration }));

    const bySlug = new Map();
    let ok = 0;
    // Retry transient "service error" responses, two queries at a time.
    const runQuery = async ([sort, period]) => {
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 700 * attempt));
        try {
          const r = await gqlPost({
            query:
              `query{user(login:"${login}"){clips(first:100, criteria:{period:${period}, sort:${sort}})` +
              `{edges{node{slug durationSeconds videoOffsetSeconds video{id}}}}}}`
          });
          const conn = r && r.data && r.data.user && r.data.user.clips;
          if (!conn) throw new Error("no data");
          ok++;
          for (const { node: n } of conn.edges) {
            if (!n || !n.video || String(n.video.id) !== videoId) continue;
            if (typeof n.videoOffsetSeconds !== "number" || !n.durationSeconds) continue;
            const start = Math.max(0, n.videoOffsetSeconds - n.durationSeconds + CLIP_START_BIAS);
            bySlug.set(n.slug, { slug: n.slug, start, end: start + n.durationSeconds });
          }
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      note("clips:" + sort + "/" + period + " " + ((lastErr && lastErr.message) || lastErr) + " (after 4 tries)", GQL_URL);
    };
    const pending = CLIP_QUERIES.slice();
    await Promise.all(
      [0, 1].map(async () => {
        while (pending.length) await runQuery(pending.shift());
      })
    );
    if (ok === 0) throw new Error("every clip query failed");
    const clips = Array.from(bySlug.values());
    log(`clips:${clips.length} from this VOD (${ok}/${CLIP_QUERIES.length} queries ok)`, GQL_URL);
    return { clips, muted };
  })();
  job.catch((err) => {
    note("clips:" + ((err && err.message) || err), GQL_URL);
    clipLists.delete(videoId);
  });
  clipLists.set(videoId, job);
  return job;
}

/** Union-length of clip coverage inside the muted ranges, in seconds. */
function coveredSeconds(clips, ranges) {
  let total = 0;
  for (const r of ranges) {
    const parts = clips
      .map((c) => [Math.max(c.start, r.start), Math.min(c.end, r.end)])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    let reach = r.start;
    for (const [a, b] of parts) {
      if (b <= reach) continue;
      total += b - Math.max(a, reach);
      reach = b;
    }
  }
  return Math.round(total);
}

/* ------------------------------------- Kick mirror: the full-audio source */

// Kick doesn't mute VODs: find the same stream there, measure the offset, and
// serve muted ranges as WAV chunks cut from its audio.
const KICK_CHUNK_S = 30; // small enough that a seek into a range gets audio quickly
const KICK_SR = 32000;
/** vodKey -> { url, segs } of the Twitch media playlist. */
const vodPlaylists = new Map();
/** videoId -> Promise<{ segs, delta, r, base } | null> */
const kickInfo = new Map();

function parseM3u8Segments(text, baseUrl) {
  const segs = [];
  let t = 0;
  let d = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      d = parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    segs.push({ t, d, url: new URL(line, baseUrl).href });
    t += d;
    d = 0;
  }
  return segs;
}

/** MPEG-TS bytes -> the audio elementary stream (ADTS AAC), or null. */
function tsToAdts(u8) {
  const parts = [];
  let pmtPid = -1;
  let audioPid = -1;
  for (let i = 0; i + 188 <= u8.length; i += 188) {
    if (u8[i] !== 0x47) return null;
    const pusi = (u8[i + 1] & 0x40) !== 0;
    const pid = ((u8[i + 1] & 0x1f) << 8) | u8[i + 2];
    const afc = (u8[i + 3] >> 4) & 3;
    let p = i + 4;
    if (afc === 2) continue;
    if (afc === 3) p += 1 + u8[p];
    if (p >= i + 188) continue;
    if (pid === 0 && pusi) {
      p += 1 + u8[p];
      const end = p + 3 + (((u8[p + 1] & 0x0f) << 8) | u8[p + 2]) - 4;
      for (let q = p + 8; q < end; q += 4) {
        if (((u8[q] << 8) | u8[q + 1]) !== 0) {
          pmtPid = ((u8[q + 2] & 0x1f) << 8) | u8[q + 3];
          break;
        }
      }
    } else if (pid === pmtPid && pusi) {
      p += 1 + u8[p];
      const end = p + 3 + (((u8[p + 1] & 0x0f) << 8) | u8[p + 2]) - 4;
      let q = p + 12 + (((u8[p + 10] & 0x0f) << 8) | u8[p + 11]);
      while (q < end) {
        const type = u8[q];
        const epid = ((u8[q + 1] & 0x1f) << 8) | u8[q + 2];
        if (type === 0x0f && audioPid < 0) audioPid = epid;
        q += 5 + (((u8[q + 3] & 0x0f) << 8) | u8[q + 4]);
      }
    } else if (pid === audioPid) {
      if (pusi) p += 9 + u8[p + 8];
      if (p < i + 188) parts.push(u8.subarray(p, i + 188));
    }
  }
  if (!parts.length) return null;
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

/** Fetch TS segments, keep their audio, decode to mono Float32 at KICK_SR. */
async function decodeSegments(urls) {
  const adts = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const res = await timedFetch(urls[i], false);
      if (!res.ok) throw new Error("segment HTTP " + res.status);
      const a = tsToAdts(new Uint8Array(await res.arrayBuffer()));
      if (!a) throw new Error("no audio in segment");
      adts[i] = a;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
  const all = new Uint8Array(adts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of adts) {
    all.set(x, o);
    o += x.length;
  }
  const ctx = new OfflineAudioContext(1, 1, KICK_SR);
  const buf = await ctx.decodeAudioData(all.buffer);
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }
  return mono;
}

/** 10 ms log-energy envelope. */
function envelope(x) {
  const hop = KICK_SR / 100;
  const out = new Float64Array(Math.floor(x.length / hop));
  for (let k = 0; k < out.length; k++) {
    let s = 0;
    for (let j = k * hop; j < (k + 1) * hop; j++) s += x[j] * x[j];
    out[k] = Math.log10(1e-9 + s / hop);
  }
  return out;
}

function zscore(a) {
  let m = 0;
  for (const v of a) m += v;
  m /= a.length;
  let sd = 0;
  for (const v of a) sd += (v - m) ** 2;
  sd = Math.sqrt(sd / a.length) || 1;
  return a.map((v) => (v - m) / sd);
}

/** Best alignment of `needle` inside `hay` (both envelopes): { off, r }. */
function bestLag(hay, needle) {
  const n = zscore(needle);
  let best = { off: 0, r: -1 };
  for (let off = 0; off + n.length <= hay.length; off++) {
    const w = zscore(hay.slice(off, off + n.length));
    let r = 0;
    for (let i = 0; i < n.length; i++) r += w[i] * n[i];
    r /= n.length;
    if (r > best.r) best = { off, r };
  }
  return best;
}

function twitchSegUrl(playlistUrl, path) {
  // Smallest rendition that carries the same audio: audio_only, else 160p30.
  const abs = new URL(path, playlistUrl);
  const parts = abs.pathname.split("/");
  const list = qualities.get(abs.origin + parts.slice(0, -2).join("/")) || [];
  const pick = list.includes("audio_only") ? "audio_only" : list.includes("160p30") ? "160p30" : null;
  if (pick) parts[parts.length - 2] = pick;
  return abs.origin + parts.join("/");
}

/** Kick names to try: login, display name, social links, @mentions (e.g. zackrawrr -> asmongold). */
function kickCandidates(owner, title) {
  const out = [owner.login, owner.displayName];
  const urls = ((owner.channel && owner.channel.socialMedias) || []).map((s) => s.url || "");
  const text = [title || "", owner.description || "", ...urls].join(" ");
  const patterns = [
    /kick\.com\/(\w+)/gi,
    /reddit\.com\/r\/(\w+)/gi,
    /(?:twitter|x)\.com\/(\w+)/gi,
    /youtube\.com\/(?:@|c\/|user\/)(\w+)/gi,
    /(?:instagram|tiktok)\.com\/@?(\w+)/gi,
    /@(\w+)/g
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1]);
  const seen = new Set();
  return out
    .map((n) => String(n || "").toLowerCase())
    .filter((n) => /^\w{3,25}$/.test(n) && !seen.has(n) && seen.add(n))
    .slice(0, 8);
}

function kickFor(videoId, vodKey) {
  if (kickInfo.has(videoId)) return kickInfo.get(videoId);
  const pl = vodPlaylists.get(vodKey);
  if (!pl) return Promise.resolve(undefined); // playlist not seen yet: ask again later
  const job = (async () => {
    const v = await gqlPost({
      query:
        `query{video(id:"${videoId}"){createdAt lengthSeconds title owner{login displayName description ` +
        `channel{socialMedias{url}}}}}`
    });
    const video = v && v.data && v.data.video;
    const owner = video && video.owner;
    if (!owner || !/^\w+$/.test(owner.login)) return null;
    const names = kickCandidates(owner, video.title);
    const created = Date.parse(video.createdAt);
    // The same stream started within 15 min on one of the candidate channels.
    const lists = await Promise.all(
      names.map((name) =>
        timedFetch(`https://kick.com/api/v2/channels/${name}/videos`, false)
          .then((res) => (res.ok ? res.json() : []))
          .catch(() => [])
      )
    );
    let match = null;
    lists.forEach((list, i) => {
      for (const k of Array.isArray(list) ? list : []) {
        const when = Date.parse(String(k.start_time || k.created_at).replace(" ", "T") + "Z");
        const dur = (k.duration || 0) / 1000;
        if (!k.source || Math.abs(when - created) > 15 * 60000) continue;
        if (dur && Math.abs(dur - video.lengthSeconds) > 900) continue;
        if (!match || Math.abs(when - created) < match.gap) match = { k, gap: Math.abs(when - created), name: names[i] };
      }
    });
    if (!match) {
      log(`kick:no matching VOD on kick.com/{${names.join(",")}}`, "https://kick.com/");
      return null;
    }
    log(`kick:VOD found on kick.com/${match.name}`, "https://kick.com/" + match.name);

    const master = await (await timedFetch(match.k.source, false)).text();
    let variant = null;
    let lowest = Infinity;
    const lines = master.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /BANDWIDTH=(\d+)/.exec(lines[i]);
      if (lines[i].startsWith("#EXT-X-STREAM-INF") && m && +m[1] < lowest && lines[i + 1]) {
        lowest = +m[1];
        variant = new URL(lines[i + 1].trim(), match.k.source).href;
      }
    }
    if (!variant) return null;
    const segs = parseM3u8Segments(await (await timedFetch(variant, false)).text(), variant);
    if (!segs.length) return null;

    // Offset: 20 s of unmuted Twitch audio matched against 100 s of Kick audio.
    const tw = pl.segs;
    let pick = -1;
    for (let i = 6; i + 8 < tw.length; i++) {
      if (tw[i].start < 300) continue;
      if (tw.slice(i - 6, i + 8).every((s) => !s.muted)) {
        pick = i;
        break;
      }
    }
    if (pick < 0) return null;
    const twWin = tw.slice(pick, pick + 2);
    const tw0 = twWin[0].start;
    const twAudio = await decodeSegments(twWin.map((s) => twitchSegUrl(pl.url, s.path)));
    const kWin = segs.filter((s) => s.t + s.d > tw0 - 50 && s.t < tw0 + 50);
    const kAudio = await decodeSegments(kWin.map((s) => s.url));
    const lag = bestLag(envelope(kAudio), envelope(twAudio));
    const delta = tw0 - (kWin[0].t + lag.off / 100);
    log(`kick:found ${match.k.slug.slice(0, 40)} offset ${delta.toFixed(2)}s r=${lag.r.toFixed(3)}`, match.k.source);
    if (lag.r < 0.8) {
      note(`kick:audio does not match Twitch (r=${lag.r.toFixed(2)}) - not used`, match.k.source);
      return null;
    }
    return { segs, delta, r: lag.r };
  })().catch((err) => {
    note("kick:" + ((err && err.message) || err), "https://kick.com/");
    return null;
  });
  kickInfo.set(videoId, job);
  return job;
}

function wav(mono, sr) {
  const out = new DataView(new ArrayBuffer(44 + mono.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + mono.length * 2, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, sr, true);
  out.setUint32(28, sr * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, mono[i])) * 32767, true);
  return out.buffer;
}

/** Kick audio for Twitch times [a, b) as a WAV whose sample 0 is Twitch time a. */
async function kickChunk(videoId, a, b) {
  const info = await kickInfo.get(String(videoId));
  if (!info || !(b > a)) return null;
  const ka = a - info.delta;
  const kb = b - info.delta;
  const win = info.segs.filter((s) => s.t + s.d > ka && s.t < kb);
  if (!win.length) return null;
  try {
    const mono = await decodeSegments(win.map((s) => s.url));
    const from = Math.max(0, Math.round((ka - win[0].t) * KICK_SR));
    const len = Math.round((kb - ka) * KICK_SR);
    const part = mono.subarray(from, from + len);
    counters.kickChunks++;
    return wav(part, KICK_SR);
  } catch (err) {
    note("kick:chunk " + ((err && err.message) || err), win[0].url);
    return null;
  }
}

/** Union of {start, end} ranges; touching ranges (gap < 0.5 s) are joined. */
function mergeRanges(list) {
  const out = [];
  for (const r of list.slice().sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.5) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

async function clipPlan(videoId, tabId) {
  if (!/^\d+$/.test(String(videoId))) return { ready: true, ranges: [], clips: [] };
  const rep = reportFor(tabId);
  if (!rep.clipInfo) rep.clipStatus = "searching";
  // undefined = not decided yet (playlist not parsed), null = no Kick source.
  const kickJob = rep.key
    ? kickFor(String(videoId), rep.key)
    : Promise.resolve(rep.sawPlaylist && rep.ranges.length === 0 && rep.note ? null : undefined);
  let found;
  try {
    found = await clipsFor(String(videoId));
  } catch (err) {
    rep.clipStatus = "error: " + ((err && err.message) || err);
    return { ready: false, ranges: [], clips: [] };
  }
  const report = tabReports.get(tabId);
  const done = report ? report.ranges.filter((r) => r.total > 0 && r.cached === r.total) : [];
  // The silence is exactly the -muted segments; muteInfo is off at the edges,
  // so it's only a fallback until the playlist is parsed.
  const ranges =
    report && report.ranges.length
      ? mergeRanges(report.ranges.filter((r) => !done.includes(r)).map((r) => ({ start: r.id, end: r.endSec })))
      : found.muted;
  const useful = found.clips.filter((c) => ranges.some((r) => c.start < r.end && c.end > r.start));
  if (report) {
    report.clipStatus = "ok";
    report.clipList = useful;
    report.clipInfo = {
      found: found.clips.length,
      useful: useful.length,
      covered: coveredSeconds(useful, ranges),
      muted: Math.round(ranges.reduce((n, r) => n + (r.end - r.start), 0))
    };
  }
  const kick = await kickJob;
  if (report) {
    report.kick = kick ? { delta: kick.delta, r: kick.r } : kick === null ? false : undefined;
  }
  return {
    ready: kick !== undefined,
    ranges,
    clips: useful,
    kick: kick ? { delta: kick.delta, chunk: KICK_CHUNK_S } : null
  };
}

/** Clip file bytes for content.js (it makes a same-origin blob: the clip CDN sends no CORS). */
async function clipBytes(slug) {
  const url = await clipSource(slug);
  if (!url) return null;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) {
      note("clips:file HTTP " + res.status, url);
      return null;
    }
    return await res.arrayBuffer();
  } catch (err) {
    note("clips:file " + ((err && err.name) || err), url);
    return null;
  }
}

async function clipSource(slug) {
  if (!/^[\w-]+$/.test(String(slug))) return null;
  let clip;
  try {
    const r = await gqlPost([
      {
        operationName: "VideoAccessToken_Clip",
        variables: { slug },
        extensions: { persistedQuery: { version: 1, sha256Hash: CLIP_TOKEN_HASH } }
      }
    ]);
    clip = r && r.data && r.data.clip;
  } catch (err) {
    note("clips:token " + ((err && err.message) || err), GQL_URL);
  }
  if (!clip) {
    const r = await gqlPost({
      query: `query{clip(slug:"${slug}"){playbackAccessToken(params:{platform:"web",playerBackend:"mediaplayer",playerType:"site"}){signature value} videoQualities{quality sourceURL}}}`
    }).catch(() => null);
    clip = r && r.data && r.data.clip;
  }
  if (!clip || !clip.playbackAccessToken || !clip.videoQualities || !clip.videoQualities.length) {
    note("clips:no playable source", slug);
    return null;
  }
  // Audio is identical across qualities; take the smallest download.
  const q = clip.videoQualities.slice().sort((a, b) => parseInt(a.quality, 10) - parseInt(b.quality, 10))[0];
  const t = clip.playbackAccessToken;
  return `${q.sourceURL}?sig=${encodeURIComponent(t.signature)}&token=${encodeURIComponent(t.value)}`;
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "clipPlan") return clipPlan(message.videoId, sender.tab ? sender.tab.id : -1);
  if (message.type === "clipBytes") return clipBytes(message.slug);
  if (message.type === "kickChunk") return kickChunk(message.videoId, message.a, message.b);
  if (message.type === "clipState") {
    if (sender.tab) {
      reportFor(sender.tab.id).live = Object.assign({ at: Date.now() }, message.state);
      if (typeof message.state.t === "number") prefetchNear(sender.tab.id, message.state.t);
      return Promise.resolve({ real: reportFor(sender.tab.id).real || [] });
    }
    return Promise.resolve(true);
  }
  if (message.type === "clipPlaying") {
    counters.clipPlays++;
    log(
      `clips:playing ${message.slug} @${formatTime(message.at)} sync ${message.sync}` +
        (typeof message.shift === "number" ? ` (${message.shift >= 0 ? "+" : ""}${message.shift.toFixed(2)}s)` : ""),
      GQL_URL
    );
    return Promise.resolve(true);
  }
  if (message.type === "getReport") {
    const tabId = message.tabId === "self" && sender.tab ? sender.tab.id : message.tabId;
    const full = tabReports.get(tabId);
    // The popup doesn't need the per-range URL lists.
    const report = full
      ? Object.assign({}, full, {
          clipList: undefined,
          ranges: full.ranges.map((r) => {
            const copy = Object.assign({}, r);
            delete copy.urls;
            if (full.clipList && typeof r.endSec === "number") {
              copy.clipSec = coveredSeconds(full.clipList, [{ start: r.id, end: r.endSec }]);
            }
            return copy;
          })
        })
      : null;
    return Promise.resolve({
      settings,
      report,
      diag: diag.slice(-25).reverse(),
      counters,
      notes: Array.from(notes, ([kind, count]) => `${count}\u00d7 ${kind}`),
      queued: queue.length,
      active: activeWorkers
    });
  }
  if (message.type === "setSetting") return browser.storage.local.set({ [message.key]: message.value });
  if (message.type === "clearCache") return clearCache().then(() => true);
  if (message.type === "retry") {
    for (const [url, entry] of cacheIndex) if (entry.status === "miss") cacheIndex.delete(url);
    notes.clear();
    vodStats.clear();
    clipLists.clear();
    for (const [id, job] of kickInfo) job.then((k) => !k && kickInfo.delete(id));
    rangeWins = 0;
    rangeLosses = 0;
    const retry = [];
    for (const url of owner.keys()) if (!cacheIndex.has(url)) retry.push(url);
    enqueue(retry);
    return Promise.resolve(retry.length);
  }
  if (message.type === "reset") {
    tabReports.delete(message.tabId);
    diag.length = 0;
    return Promise.resolve(true);
  }
  return false;
});
