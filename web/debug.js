// "Debug info": a plain-text account of this browser, its GPU, the open
// video and the jobs of this visit (with the last scan's time per
// operation), for someone helping with a slow or failing run. File names
// are left out.

const errors = [];
const jobs = [];
const names = new Set(); // the files opened this visit, which the report leaves out
let hiddenSince = document.visibilityState === 'hidden' ? performance.now() : null;
let hiddenTotal = 0;

/** Time the tab has spent out of sight this visit, in ms. */
function hiddenMs() {
  return hiddenTotal + (hiddenSince === null ? 0 : performance.now() - hiddenSince);
}

/** Keep the page's last errors and how long it was out of sight, for the report. */
export function watchPage() {
  window.addEventListener('error', (e) => noteError(e.message || String(e.error)));
  window.addEventListener('unhandledrejection', (e) => noteError(`unhandled: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (hiddenSince === null) hiddenSince = performance.now();
    } else if (hiddenSince !== null) {
      hiddenTotal += performance.now() - hiddenSince;
      hiddenSince = null;
    }
  });
}

/** A file opened this visit: the report will not name it. */
export function noteFileName(name) {
  if (name) names.add(name);
}

export function noteError(text) {
  errors.push(`${clock(Date.now())} ${text}`);
  if (errors.length > 20) errors.shift();
}

/** A job starts: returns what to call when it ends, with its outcome. */
export function noteJob(name) {
  const at = Date.now();
  const t0 = performance.now();
  const h0 = hiddenMs();
  return (outcome) => {
    jobs.push({ name, at, ms: performance.now() - t0, hidden: hiddenMs() - h0, outcome });
    if (jobs.length > 40) jobs.shift();
  };
}

const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const int = (n) => Math.round(n).toLocaleString('en');

function duration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s - h * 3600 - m * 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${r.toFixed(1).padStart(4, '0')}`;
}

function bytes(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

/** A labelled block of lines, the ones after the first indented under the label. */
const LABEL = 10;
function block(label, lines) {
  const out = [];
  lines.filter((l) => l !== null && l !== undefined && l !== '').forEach((l, i) => out.push(`${(i ? '' : label).padEnd(LABEL)}${l}`));
  return out.length ? out : [`${label.padEnd(LABEL)}none`];
}

/** What each decoder of a hybrid scan did. */
function hybridLine(h) {
  const lanes = h.lanes.map((l) => {
    const fps = l.frames / Math.max(0.001, l.ms / 1000);
    return `${l.kind === 'built-in' ? `built-in decoder ×${l.workers}` : "browser's decoder"}: ${int(l.frames)} frames, ${fps.toFixed(0)} fps${l.runs > 1 ? `, ${l.runs} runs` : ''}${l.failed ? `, gave up: ${l.failed}` : ''}`;
  });
  return [`hybrid: ${h.chunks} chunks of about ${h.chunkS} s, scanned in ${h.parts.length} run${h.parts.length === 1 ? '' : 's'}`, ...lanes];
}

/**
 * The report, from the page's `state` and `profile`, the app's `version`,
 * the WebGPU adapter's description of itself (`gpu`), the number of
 * segments a scan would use and the hybrid plan it would follow (if any).
 */
export function debugReport({ version, state, profile, gpu, segments, hybrid = null }) {
  const lines = [`Unflash debug info · ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`];
  lines.push(...block('App', [`${version} · ${location.origin}${location.pathname}${location.search ? ` · options ${location.search}` : ''}`]));
  const nav = navigator;
  const ua = nav.userAgentData;
  lines.push(
    ...block('Browser', [
      nav.userAgent,
      [ua && ua.platform, `${nav.hardwareConcurrency || '?'} logical cores`, nav.deviceMemory ? `${nav.deviceMemory} GB of memory or more` : null, `screen ×${window.devicePixelRatio || 1}`, `tab ${document.visibilityState === 'hidden' ? 'out of sight' : 'in front'}`, window.crossOriginIsolated ? 'cross-origin isolated' : null].filter(Boolean).join(' · '),
    ])
  );
  const g = gpu && gpu.info;
  lines.push(
    ...block('GPU', [
      !navigator.gpu ? 'no WebGPU in this browser' : g ? [g.vendor, g.architecture, g.device, g.description].filter(Boolean).join(' · ') || 'WebGPU (the adapter gives no description)' : 'WebGPU (adapter not described)',
      gpu && gpu.fallback ? 'a fallback (software) adapter' : null,
    ])
  );
  const env = state.env;
  if (env) {
    const f = env.feeder;
    const det = [];
    det.push(`${f.backend === 'webgpu' ? 'WebGPU' : 'CPU (WebAssembly)'} at ${f.aw}×${f.ah}${f.note ? ` (${f.note})` : ''}`);
    det.push(`pictures reach it as: ${f.route || 'nothing yet'}${f.routeDetail ? ` (${f.routeDetail})` : ''}${f.takesFrames === false && f.backend === 'webgpu' ? ' · this WebGPU takes no decoded frame' : ''}`);
    const m = state.movie;
    const scans = hybrid ? `scans hybrid: ${hybrid.hw} lane${hybrid.hw === 1 ? '' : 's'} of the browser's decoder${hybrid.sw ? ` + the built-in decoder in ${hybrid.sw} worker${hybrid.sw === 1 ? '' : 's'}` : ''}` : `scans in ${segments > 1 ? `up to ${segments} segments` : 'one piece'}`;
    det.push(`decoding: ${state.decode && state.decode.software ? 'the built-in H.264 decoder' : m && m.decodeInWorkers ? 'WebCodecs, in workers' : 'WebCodecs, on the page'} · ${scans}`);
    lines.push(...block('Detector', det));
  }
  const m = state.movie;
  if (m) {
    const v = m.video || {};
    const a = m.audio;
    lines.push(
      ...block('Video', [
        [String(m.format || '?').toUpperCase(), v.codec, `${m.width}×${m.height}`, `${(m.fps || 0).toFixed(3)} fps`, duration(m.duration || 0), `${int(m.frameCount || 0)} frames`, m.file ? bytes(m.file.size) : null].filter(Boolean).join(' · '),
        a ? `audio ${a.codec}${a.copyable === false ? ' (re-encoded on export)' : ''}` : 'no audio',
        state.decode && !state.decode.supported && state.decode.reason ? `cannot decode: ${state.decode.reason}` : null,
      ])
    );
  } else lines.push(...block('Video', ['none open']));
  const s = state.lastScan;
  if (s) {
    const fps = s.frames / Math.max(0.001, s.elapsedMs / 1000);
    const head = `${int(s.frames)} frames in ${secs(s.elapsedMs)} = ${fps.toFixed(0)} fps${m && m.fps ? ` (${(fps / m.fps).toFixed(1)}× real time)` : ''}`;
    lines.push(...block('Scan', s.hybrid ? [head, ...hybridLine(s.hybrid)] : [`${head} · ${s.segments || 1} segment${(s.segments || 1) === 1 ? '' : 's'}`]));
  }
  lines.push(...block('Jobs', jobs.map((j) => `${clock(j.at)} ${j.name}: ${secs(j.ms)} ${j.outcome}${j.hidden > 500 ? ` (${secs(j.hidden)} of it out of sight)` : ''}`)));
  const job = state.job;
  if (job) lines.push(...block('Running', [`${job.name}: ${secs(performance.now() - (job.t0 || performance.now()))} so far, ${job.pct || 0}% done (the report of it comes when it ends)`]));
  if (state.project) {
    const n = state.project.sections.length;
    lines.push(...block('Project', [`${n} section${n === 1 ? '' : 's'} · caches ${bytes(state.project.cacheBytes())}`]));
  }
  if (s && s.profileText) lines.push('', 'Last scan, time per operation:', s.profileText);
  const now = profile.summary();
  if (now && !(s && now === s.profileOps)) lines.push('', 'The last job, time per operation:', now);
  lines.push('', ...block('Errors', errors.slice()));
  let text = lines.join('\n');
  // no file names
  for (const name of [...names].sort((a, b) => b.length - a.length)) text = text.split(name).join('<a file>');
  return text;
}
