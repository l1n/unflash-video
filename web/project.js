// The project: sections, marks and verdicts, persisted in IndexedDB. Frame
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

export function projectKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
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

  static async load(key, bounds, keyframes) {
    const p = new Project(key, bounds, keyframes);
    try {
      const saved = await idbGet(key);
      if (saved) {
        p.profile = saved.profile || 'wcag_ext';
        p.nextId = saved.nextId || 1;
        p.scan = saved.scan || null;
        p.sections = (saved.sections || []).map((s) => ({
          ...s,
          prepared: false,
          cache: null,
          ctx: null,
          check: s.check || null,
          edits: s.edits || {},
        }));
      }
    } catch (e) {
      console.warn('could not load project', e);
    }
    return p;
  }

  async save() {
    const sections = this.sections.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      kinds: s.kinds || [],
      edits: s.edits || {},
      check: s.check ? summarizeCheck(s.check) : null,
      nFrames: s.nFrames || 0,
      pts: s.pts || null,
      warnings: s.warnings || [],
      custom: !!s.custom,
    }));
    try {
      await idbPut(this.key, { profile: this.profile, nextId: this.nextId, scan: this.scan, sections, savedAt: Date.now() });
    } catch (e) {
      console.warn('could not save project', e);
    }
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
      prepared: false,
      cache: null,
      ctx: null,
      check: null,
      custom,
    };
    this.sections.push(sec);
    return sec;
  }

  deleteSection(id) {
    const sec = this.section(id);
    if (!sec) return;
    if (sec.cache) sec.cache.clear();
    if (sec.ctx) {
      sec.ctx.lead.clear();
      sec.ctx.tail.clear();
    }
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
      if (s.ctx) b += s.ctx.lead.byte_length() + s.ctx.tail.byte_length();
    }
    return b;
  }

  /** Drop caches of sections other than `keep` until under `budget` bytes. */
  evictCaches(keep, budget) {
    const order = this.sections.filter((s) => s.prepared && s.id !== (keep && keep.id)).sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0));
    for (const s of order) {
      if (this.cacheBytes() <= budget) break;
      if (s.cache) s.cache.clear();
      if (s.ctx) {
        s.ctx.lead.clear();
        s.ctx.tail.clear();
      }
      s.cache = null;
      s.ctx = null;
      s.prepared = false;
    }
  }
}

/** The part of a check verdict worth keeping across reloads. */
export function summarizeCheck(c) {
  return {
    safe: c.safe,
    wcag_safe: c.wcag_safe,
    flag_extended: c.flag_extended,
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
