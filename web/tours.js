// What the guided tour says, and when it comes. A first visit gets the
// getting-started tour in three parts, each the first time its part of the
// app is on screen: the start page, then the first video, then the first
// section. Coming back after an update, each change that brought something
// to see gets a short tour of its own (CHANGELOG.md names it:
// `<!-- HH:MM tour:id -->`), again once its part of the app is on screen.
// A tour starts only when nothing else is going on (no job running, no
// dialog open, no click or key in the last moment), each one once; the
// guide has the whole tour again, and What's new a "show me" for each.

import { Tour, stepShowable } from './tour.js';

const GETTING_STARTED = ['start', 'video', 'section'];

/** The tours: where each can be shown (`context`), and its steps. */
export const TOURS = {
  start: {
    label: 'Getting started',
    context: 'start',
    steps: [
      {
        title: 'Welcome to Unflash',
        html: 'Unflash finds the flashing and the stripe patterns in a video that can trigger seizures, and helps you take them out without wrecking the footage. It all happens in this browser: nothing is uploaded.<br><br>This tour takes a minute. <b>Esc</b> ends it, and the guide has it again whenever you want it.',
      },
      { target: 'label.filebtn.primary', title: 'Open a video', html: 'Start here: open a video from your disk (MP4, MOV, MKV or WebM), or drop one anywhere on the page. It is scanned as soon as it opens, every frame of it.' },
      { target: 'table.clips', placement: 'top', title: 'Or try a test clip', html: 'No video to hand? Each of these short clips has a known problem in it. <b>open</b> loads one straight in.' },
      { target: '#profileSel', title: 'What counts as a problem', html: 'The default flags WCAG failures, and also extended flashes and stripe patterns: WCAG lets those through, but they still affect some viewers. <i>Exact WCAG only</i> and <i>Stricter than WCAG</i> are the other two.' },
      { target: () => document.querySelector('#autoToggle') && document.querySelector('#autoToggle').closest('label'), title: 'Auto-fix', html: 'Tick this and a video is fixed unattended as soon as it opens: scanned, every problem fixed, exported and checked. Treat what it makes as a starting point: fixing by hand gives better results.' },
      { target: '#btnHome', title: 'The guide', html: "Everything explained step by step, and this tour again. <b>What's new</b>, beside it, lists every change, and anything new gets a short tour of its own." },
    ],
  },
  video: {
    label: 'Your video',
    context: 'video',
    steps: [
      { target: '#timelineWrap', title: 'The whole video at a glance', html: 'What the scan found, along the video: orange for general flashes, magenta for red ones, teal for stripe patterns. The numbered boxes are sections. Drag across an empty stretch to make a section of your own.' },
      { target: '#sectionList', placement: 'right', title: 'Sections', html: 'One around each problem the scan found: open one to fix it. <b>Whole video</b>, at the top, brings back the whole video.' },
      { target: '.chart-box', title: 'The flashing, charted', html: 'How much of the picture flashes, around the playhead: the bars are flashing faster than the limit (the dashed line), the blue line flashing at the limit rate, which is what extended flashes are made of. Point at it for the numbers; click it to play from there.' },
      { target: '#playerBox', title: 'The player', html: 'Dimmed and small to start with (the switches above it change that). Tick <b>live monitor</b> in the header for a meter over the picture: how much of it is flashing, frame by frame.' },
      { target: '#btnProject', title: 'Your work is kept', html: 'Sections and marks are kept in this browser as you work, and come back when you open the same video again. <b>Project…</b> saves them to a file, to keep or to carry to another computer.' },
      { target: '#btnExport', title: 'Export', html: 'Once the sections pass, <b>Export…</b> writes the fixed video (only the stretches around the sections are re-encoded) and <b>Verify</b> scans what it wrote.' },
    ],
  },
  section: {
    label: 'Fixing a section',
    context: 'section',
    steps: [
      { target: '#wsVerdict', title: 'Does it pass?', html: 'The section is checked the moment anything in it changes, with the video either side of it, exactly as the export will have it.' },
      { target: '#wsFindings', title: 'What still fails', html: 'Each problem that is left, with its frames and times and how to fix it. <b>select these frames</b> picks them out below.' },
      { target: '#frameGrid', placement: 'top', title: 'Every frame', html: 'Click a frame to select it (shift-click for a run). Then <b>R</b> removes it (the frame before shows in its place), <b>F</b> the same with the frame after, <b>E</b> holds it for a second, <b>B</b> blends it with the frames either side, <b>K</b> keeps it out of every suggestion. The same key again takes the mark off; <b>Ctrl+Z</b> undoes.' },
      { target: () => document.querySelector('#btnSuggestLight') && document.querySelector('#btnSuggestLight').closest('.group'), title: 'Suggestions', html: 'A first pass to work from. They choose by brightness alone, so look at what they did: they can take out a line of subtitles or an image that matters. Tick <b>selection only</b> to have them work on the frames you selected.' },
      { target: '#previewBar', title: 'Watch it', html: 'Plays the section with your marks, exactly as the export renders it; switch the player to <i>original</i> to compare. The sound is off to start with.' },
    ],
  },
  // new things, by the change that brought them
  'whole-video': {
    label: 'New',
    context: 'video',
    steps: [
      { target: '.sec-whole', placement: 'right', title: 'Back to the whole video', html: '<b>Whole video</b> brings back the whole video, with its flashing charted, under the limit too.' },
      { target: '#chartSpan', title: 'The whole video, charted', html: '10 s, 30 s, 2 min or all of it, around the playhead. Point at the chart for the numbers; click it to play from there.' },
    ],
  },
  'project-files': {
    label: 'New',
    context: 'video',
    steps: [{ target: '#btnProject', title: 'Project files', html: 'Save the sections, marks and scan to a file, and load them back: on another computer or browser, or after this site’s data is cleared.' }],
  },
  findings: {
    label: 'New',
    context: 'section',
    steps: [
      { target: '#wsFindings', title: 'What still fails, and how to fix it', html: 'Each problem left in the section, extended flashes too, with its frames and times, a button to select them, and what fixes it.' },
      { target: '#btnSelectUnsafe', title: 'Extended flashes, selected', html: '<b>select unsafe frames</b> now takes in extended flashes and scrolls to them. Frames inside an extended flash have a blue outline.' },
    ],
  },
  'section-sound': {
    label: 'New',
    context: 'section',
    steps: [{ target: '#btnPreviewSound', title: 'Sound in the section player', html: 'Off to start with. Held frames are silent while they wait, as they are in the export.' }],
  },
  tours: {
    label: 'New',
    context: 'any',
    steps: [{ target: '#btnHome', title: 'A guided tour', html: 'Like this one. The guide has the whole tour whenever you want it, and anything new gets a short tour of its own the first time you are where it is.' }],
  },
};

const KEY = 'unflash:tours';

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { plan: Array.isArray(v.plan) ? v.plan : [], done: v.done && typeof v.done === 'object' ? v.done : {} };
  } catch (e) {
    return { plan: [], done: {} };
  }
}

function save(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    /* storage blocked: the tours come again next time */
  }
}

/**
 * When the tours come. `where(byHand)` says which contexts are on screen
 * ({ any, start, video, section }; `byHand`: once the page is ready for a
 * tour started by hand), `quiet()` whether nothing is going on, and
 * `ready(context)` gets the page ready for a tour started by hand (the
 * guide put away over a video, say).
 */
export class TourGuide {
  constructor({ where, quiet, ready = () => {}, auto = true }) {
    this.where = where;
    this.quiet = quiet;
    this.ready = ready;
    this.auto = auto;
    this.state = load();
    this.pending = [];
    this.tour = null;
    this.timer = null;
  }

  /** Whether a tour is on screen. */
  get showing() {
    return !!(this.tour && this.tour.open);
  }

  /**
   * What this visit should be shown: `firstVisit` starts the
   * getting-started tour; `tours` are the ids of the tours of the changes
   * since the last visit.
   */
  plan({ firstVisit = false, tours = [] } = {}) {
    if (firstVisit && !this.state.plan.length) {
      this.state.plan = GETTING_STARTED.slice();
      save(this.state);
    }
    // the getting-started parts not yet seen, then the new things
    const ids = [...this.state.plan, ...tours].filter((id, k, a) => TOURS[id] && !this.state.done[id] && a.indexOf(id) === k);
    this.pending = ids;
    if (this.auto && this.pending.length && !this.timer) this.timer = setInterval(() => this.poll(), 700);
  }

  /** Start whichever waiting tours can be shown now (all those of one place, as one tour). */
  poll() {
    if (!this.pending.length) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.showing || !this.quiet()) return;
    const on = this.where();
    const now = this.pending.filter((id) => on[TOURS[id].context] && TOURS[id].steps.some(stepShowable));
    if (now.length) this.show(now);
  }

  /** Show tours `ids` now, as one (by hand: the guide's button, a "show me"). */
  show(ids, { byHand = false } = {}) {
    if (this.showing) this.tour.end('skipped');
    if (byHand) this.ready(TOURS[ids[0]].context);
    const steps = ids.flatMap((id) => TOURS[id].steps.map((s) => ({ ...s, label: TOURS[id].label })));
    const tour = new Tour(steps, {
      onEnd: (how, shown) => {
        if (this.tour === tour) this.tour = null;
        // shown, or turned down: either way it has had its turn (a tour
        // with nothing on screen waits for its place)
        if (how !== 'empty') this.markDone(ids);
      },
    });
    this.tour = tour;
    return tour.start();
  }

  /**
   * By hand: tour `id` now if its place is on screen (true), else it waits
   * for its place (false).
   */
  request(id) {
    const t = TOURS[id];
    if (!t) return false;
    const on = this.where(true);
    if (on[t.context] && t.steps.some(stepShowable)) return this.show([id], { byHand: true });
    if (!this.pending.includes(id)) this.pending.push(id);
    delete this.state.done[id];
    if (!this.timer) this.timer = setInterval(() => this.poll(), 700);
    return false;
  }

  /** The getting-started part for where the page is now, by hand. */
  gettingStarted() {
    const on = this.where(true);
    const id = on.section ? 'section' : on.video ? 'video' : 'start';
    return this.show([id], { byHand: true });
  }

  markDone(ids) {
    const at = Date.now();
    for (const id of ids) this.state.done[id] = at;
    this.pending = this.pending.filter((id) => !ids.includes(id));
    save(this.state);
  }
}
