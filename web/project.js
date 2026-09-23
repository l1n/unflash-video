// The project: sections, marks and verdicts, persisted in IndexedDB as the
// work goes on, and to a project file on request (to move it to another
// browser or computer, or keep it past clearing the site's data). Frame
// caches live in memory only and are rebuilt by preparing a section again.

const DB_NAME = 'unflash';
const STORE = 'projects';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** When a project was last saved in this browser (ms), 0 when none was: roughly when it was last used. */
export async function lastSavedAt() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    let last = 0;
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(last);
      const at = cur.value && cur.value.savedAt;
      if (at > last) last = at;
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * The most recently saved project whose key starts with `prefix`, as
 * { key, value }, or null: the same file under another modified time (a
 * copy, a download again).
 */
async function idbLatestLike(prefix) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    let best = null;
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(best);
      if (typeof cur.key === 'string' && cur.key.startsWith(prefix) && (!best || (cur.value && cur.value.savedAt) > (best.value.savedAt || 0))) best = { key: cur.key, value: cur.value };
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export function projectKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/** The same file whatever its modified time: its name and size. */
function projectKeyPrefix(key) {
  const parts = key.split(':');
  return parts.length >= 3 ? parts.slice(0, -1).join(':') + ':' : null;
}

/**
 * Drop a section's decoded frames (its caches and context); its marks and
 * frame times stay. The caches are freed, not cleared: clearing keeps the
 * allocation, and WebAssembly memory only ever grows, so a freed cache is
 * what lets the next prepare reuse the space.
 */
export function dropCaches(sec) {
  if (sec.cache) sec.cache.free();
  if (sec.softCache) sec.softCache.free();
  if (sec.blendCache) sec.blendCache.free();
  if (sec.ctx) {
    sec.ctx.lead.free();
    sec.ctx.tail.free();
  }
  sec.cache = null;
  sec.softCache = null;
  sec.softKey = null;
  sec.blendCache = null;
  sec.blendKey = null;
  sec.ctx = null;
  sec.prepared = false;
}

export class Project {
  constructor(key, bounds, keyframes) {
    this.key = key;
    this.profile = 'wcag_ext';
    this.sections = [];
    this.nextId = 1;
    this.scan = null; // { violations, summary, sections, frames, elapsedMs, profile }
    this.bounds = bounds;
    this.keyframes = keyframes;
    this.notifyMinutes = 0;
  }

  /**
   * The project saved in this browser for this file; when there is none
   * under its exact key, the latest saved for the same name and size (the
   * file copied or downloaded again: `restoredFrom` says so).
   */
  static async load(key, bounds, keyframes) {
    const p = new Project(key, bounds, keyframes);
    try {
      let saved = await idbGet(key);
      if (!saved) {
        const prefix = projectKeyPrefix(key);
        const like = prefix ? await idbLatestLike(prefix) : null;
        if (like && like.value) {
          saved = like.value;
          p.restoredFrom = like.key;
        }
      }
      if (saved) p.restore(saved);
    } catch (e) {
      console.warn('could not load project', e);
    }
    return p;
  }

  /** Take on what `toSaved` made (from this browser or a project file). */
  restore(saved) {
    this.profile = saved.profile || 'wcag_ext';
    this.nextId = saved.nextId || 1;
    this.scan = saved.scan || null;
    this.sections = (saved.sections || []).map((s) => ({
      ...s,
      prepared: false,
      cache: null,
      softCache: null,
      blendCache: null,
      ctx: null,
      check: s.check || null,
      edits: s.edits || {},
      keep: s.keep || [],
      blend: s.blend || [],
      blendStrength: s.blendStrength == null ? null : s.blendStrength,
      soften: !!s.soften,
      pattern: s.pattern || null,
    }));
    this.nextId = Math.max(this.nextId, ...this.sections.map((s) => s.id + 1));
  }

  async save() {
    try {
      await idbPut(this.key, this.toSaved());
    } catch (e) {
      console.warn('could not save project', e);
    }
  }

  /** What is kept of the project: everything but the decoded frames. */
  toSaved() {
    const sections = this.sections.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      kinds: s.kinds || [],
      edits: s.edits || {},
      keep: s.keep || [],
      blend: s.blend || [],
      blendStrength: s.blendStrength == null ? null : s.blendStrength,
      check: s.check ? summarizeCheck(s.check) : null,
      nFrames: s.nFrames || 0,
      pts: s.pts || null,
      warnings: s.warnings || [],
      custom: !!s.custom,
      soften: !!s.soften,
      pattern: s.pattern || null,
    }));
    return { profile: this.profile, nextId: this.nextId, scan: this.scan, sections, savedAt: Date.now() };
  }

  section(id) {
    return this.sections.find((s) => s.id === id) || null;
  }

  sectionsSorted() {
    return [...this.sections].sort((a, b) => a.start - b.start);
  }

  addSection(start, end, kinds = [], custom = false) {
    const [lo, hi] = this.bounds;
    start = Math.max(lo, Math.min(start, hi));
    end = Math.max(lo, Math.min(end, hi));
    if (end <= start) return null;
    const sec = {
      id: this.nextId++,
      start: Math.round(start * 1e6) / 1e6,
      end: Math.round(end * 1e6) / 1e6,
      kinds,
      edits: {},
      keep: [],
      blend: [],
      blendStrength: null,
      prepared: false,
      cache: null,
      softCache: null,
      blendCache: null,
      ctx: null,
      check: null,
      custom,
      soften: false,
      pattern: null,
    };
    this.sections.push(sec);
    return sec;
  }

  deleteSection(id) {
    const sec = this.section(id);
    if (!sec) return;
    dropCaches(sec);
    this.sections = this.sections.filter((s) => s.id !== id);
  }

  /** Sections whose checks read this one's edits: they need re-checking. */
  invalidateNeighbours(sec, seconds) {
    for (const o of this.sections) {
      if (o.id === sec.id) continue;
      if (o.end > sec.start - seconds && o.start < sec.end + seconds) {
        if (o.check) o.check.stale = true;
      }
    }
  }

  /** Bytes held by frame caches. */
  cacheBytes() {
    let b = 0;
    for (const s of this.sections) {
      if (s.cache) b += s.cache.byte_length();
      if (s.softCache) b += s.softCache.byte_length();
      if (s.blendCache) b += s.blendCache.byte_length();
      if (s.ctx) b += s.ctx.lead.byte_length() + s.ctx.tail.byte_length();
    }
    return b;
  }

  /** Drop caches of sections other than `keep` until under `budget` bytes. */
  evictCaches(keep, budget) {
    const order = this.sections.filter((s) => s.prepared && s.id !== (keep && keep.id)).sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0));
    for (const s of order) {
      if (this.cacheBytes() <= budget) break;
      dropCaches(s);
    }
  }
}

/** The part of a check verdict worth keeping across reloads. */
export function summarizeCheck(c) {
  return {
    safe: c.safe,
    wcag_safe: c.wcag_safe,
    flag_extended: c.flag_extended,
    flag_patterns: c.flag_patterns,
    pattern_thresh: c.pattern_thresh,
    soften: c.soften,
    soft_frames: c.soft_frames,
    soft_sigma: c.soft_sigma,
    violations: c.violations,
    after: c.after,
    elsewhere: c.elsewhere,
    flagged: c.flagged,
    spills: c.spills,
    profile: c.profile,
    detector_sig: c.detector_sig,
    context_notes: c.context_notes,
    frames: c.frames,
    stale: !!c.stale,
  };
}

// ---- project files ------------------------------------------------------------

const FILE_KIND = 'unflash-project';
const FILE_VERSION = 1;
const TYPED = { Float64Array, Float32Array, Uint32Array, Int32Array, Uint16Array, Int16Array, Uint8Array };

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** What identifies the video a project belongs to. */
export function videoFingerprint(movie, file) {
  return {
    name: file ? file.name : movie.name,
    size: file ? file.size : movie.file && movie.file.size,
    lastModified: file ? file.lastModified : movie.file && movie.file.lastModified,
    frames: movie.frameCount,
    duration: Math.round(movie.duration * 1e6) / 1e6,
    width: movie.width,
    height: movie.height,
    codec: movie.video && movie.video.codec,
  };
}

/**
 * The project as a file's text: JSON, the video it belongs to, and the
 * project as the browser keeps it (typed arrays, such as the scan's
 * per-frame trace, as base64 of their bytes).
 */
export function projectFileText(project, movie, file) {
  const doc = { kind: FILE_KIND, version: FILE_VERSION, saved: new Date().toISOString(), video: videoFingerprint(movie, file), project: project.toSaved() };
  return JSON.stringify(doc, (k, v) => (ArrayBuffer.isView(v) && !(v instanceof DataView) ? { $typed: v.constructor.name, b64: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } : v));
}

/** A project file's text read back: { video, saved } (saved as `toSaved` makes it). Throws with a message on anything else. */
export function readProjectFile(text) {
  let doc;
  try {
    doc = JSON.parse(text, (k, v) => {
      if (v && typeof v === 'object' && typeof v.$typed === 'string' && typeof v.b64 === 'string') {
        const T = TYPED[v.$typed];
        if (!T) throw new Error(`an array of an unknown type (${v.$typed})`);
        const bytes = fromBase64(v.b64);
        return new T(bytes.buffer, 0, bytes.byteLength / T.BYTES_PER_ELEMENT);
      }
      return v;
    });
  } catch (e) {
    throw new Error(`This is not an Unflash project file (${e.message}).`);
  }
  if (!doc || doc.kind !== FILE_KIND || !doc.project || !doc.video) throw new Error('This is not an Unflash project file.');
  if (doc.version > FILE_VERSION) throw new Error('This project file comes from a newer Unflash; reload the page to get the newest, then load it again.');
  if (!Array.isArray(doc.project.sections)) throw new Error('This project file has no sections list.');
  return { video: doc.video, saved: doc.project };
}

/**
 * Whether a project file's video is the open one: its frames and length must
 * match (the marks are on frames); the name and the size only say whether it
 * is the very same file. Returns { ok, same, why }.
 */
export function matchVideo(fp, movie, file) {
  const here = videoFingerprint(movie, file);
  const oneFrame = movie.medianDelta || 1 / 30;
  const framesOk = fp.frames === here.frames;
  const lengthOk = Math.abs((fp.duration || 0) - here.duration) <= oneFrame;
  const same = fp.name === here.name && fp.size === here.size;
  if (framesOk && lengthOk) return { ok: true, same };
  return { ok: false, same, why: `The project is for ${fp.name} (${fp.frames} frames, ${(fp.duration || 0).toFixed(3)} s); the open video has ${here.frames} frames and lasts ${here.duration.toFixed(3)} s. Open the video it was made for, then load it again.` };
}
