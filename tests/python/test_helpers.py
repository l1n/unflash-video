"""The reference's rules that need no video: profiles, how marks become an
edited timeline, sections around violations, frame times made sane.

The Rust port restates each of these (crates/unflash-core: config.rs,
editing.rs, timeline.rs, sections.rs) and tests its statement; the cases
here are the port's own, value for value, so the two are held to the same
answers and cannot drift apart unnoticed.

    python3 -m unittest discover -s tests/python

Needs numpy (the package imports it).
"""
import os
import sys
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

try:
    import numpy  # noqa: F401
except ImportError:  # pragma: no cover
    numpy = None

REQUIRED = os.environ.get("UNFLASH_REQUIRE_NUMPY")
needs_numpy = unittest.skipIf(numpy is None and not REQUIRED, "numpy is not installed")


def removed(fill="prev"):
    return {"removed": True, "fill": fill}


@needs_numpy
class Profiles(unittest.TestCase):
    def setUp(self):
        from unflash import config

        self.config = config

    def test_the_three_profiles(self):
        c = self.config
        ext, wcag, strict = (c.profile_config(p) for p in ("wcag_ext", "wcag", "strict"))
        # WCAG's own numbers: a swing of a tenth, a quarter of the window, three flashes a second
        for cfg in (ext, wcag):
            self.assertEqual((cfg.swing_threshold, cfg.dark_threshold, cfg.area_fraction, cfg.flash_limit), (0.10, 0.80, 0.25, 3.0))
            self.assertEqual((cfg.red_delta_threshold, cfg.red_saturation), (0.2, 0.80))
            self.assertEqual((cfg.screen_w, cfg.screen_h, cfg.window_w, cfg.window_h), (1024, 768, 341, 256))
        # the default reports extended flashes (five seconds at the limit); exact WCAG does not
        self.assertTrue(ext.flag_extended)
        self.assertFalse(wcag.flag_extended)
        self.assertEqual((ext.extended_window, ext.extended_coverage, ext.extended_hold), (5.0, 0.80, 1.0))
        # the stricter one: fainter, smaller, two a second, and no close calls of its own
        self.assertEqual((strict.swing_threshold, strict.area_fraction, strict.flash_limit), (0.08, 0.20, 2.0))
        self.assertFalse(strict.flag_extended)
        self.assertFalse(strict.warnings)
        # what a close call is measured against is the stricter profile's thresholds
        self.assertEqual((ext.warn_swing, ext.warn_area_fraction, ext.warn_flash_limit), (strict.swing_threshold, strict.area_fraction, strict.flash_limit))
        self.assertIsNone(c.profile_config("nonesuch"))
        self.assertEqual(c.DEFAULT_PROFILE, "wcag_ext")

    def test_a_profile_is_known_by_its_settings(self):
        c = self.config
        for name in c.PROFILES:
            self.assertEqual(c.profile_name(c.profile_config(name).to_dict()), name)
        custom = c.profile_config("wcag").to_dict()
        custom["flash_limit"] = 2.5
        self.assertEqual(c.profile_name(custom), "custom")

    def test_a_signature_changes_with_what_can_change_a_verdict_and_nothing_else(self):
        c = self.config
        base = c.DetectorConfig().to_dict()
        sig = c.detector_signature(base)
        self.assertRegex(sig, r"^[0-9a-f]{12}$")
        self.assertEqual(c.detector_signature(dict(base)), sig)
        # how a scan is cut into sections, and what is said of flashing that passes, change no verdict
        for key, value in (("section_pad", 9.0), ("section_max_len", 10.0), ("warnings", False), ("warn_swing", 0.01)):
            self.assertEqual(c.detector_signature({**base, key: value}), sig, key)
        for key, value in (("swing_threshold", 0.11), ("flash_limit", 2.0), ("extended_mode", "off"), ("analysis_scale", 0.5), ("red_flare", 0.0)):
            self.assertNotEqual(c.detector_signature({**base, key: value}), sig, key)
        # settings this version does not know are passed over, and missing ones are the defaults
        self.assertEqual(c.detector_signature({**base, "from_the_future": 1}), sig)
        self.assertEqual(c.detector_signature({}), sig)
        self.assertEqual(c.detector_signature(None), sig)

    def test_settings_round_trip_and_ignore_what_they_do_not_know(self):
        c = self.config
        cfg = c.DetectorConfig.from_dict({"flash_limit": 2.0, "nonsense": True})
        self.assertEqual(cfg.flash_limit, 2.0)
        self.assertEqual(c.DetectorConfig.from_dict(cfg.to_dict()), cfg)
        rc = c.RenderConfig.from_dict({"crf": 20, "nonsense": True})
        self.assertEqual((rc.crf, rc.extension_seconds), (20, 1.0))
        self.assertEqual(c.RenderConfig.from_dict(rc.to_dict()), rc)


@needs_numpy
class Marks(unittest.TestCase):
    """(the cases of crates/unflash-core/src/editing.rs and timeline.rs)"""

    def setUp(self):
        from unflash import editing

        self.e = editing

    def test_a_removed_frame_shows_the_nearest_survivor_its_way_or_else_the_other(self):
        rep = self.e.replacement_map
        # nothing before frame 0: it falls forward; nothing after frame 4: it falls back
        self.assertEqual(rep({0: removed(), 1: removed(), 2: removed("next"), 4: removed("next")}, 5), [3, 3, 3, 3, 3])
        self.assertEqual(rep({1: removed(), 2: removed("next")}, 4), [0, 0, 3, 3])
        # nothing left at all: the first frame is held
        self.assertEqual(rep({0: removed(), 1: removed(), 2: removed()}, 3), [0, 0, 0])
        self.assertEqual(rep({}, 3), [0, 1, 2])
        self.assertEqual(rep(None, 2), [0, 1])
        # marks as a project file has them: keyed by text
        self.assertEqual(rep({"1": removed()}, 3), [0, 0, 2])

    def test_a_held_frame_puts_everything_after_it_a_second_later(self):
        pts = [0.0, 0.1, 0.2, 0.3]
        edits = {1: {"extended": True}, 2: removed("next")}
        self.assertEqual(self.e.edited_sequence(pts, edits, 1.0), [(0.0, 0), (0.1, 1), (1.2, 3), (1.3, 3)])
        # the picture that stands in for a frame removed "next" is on screen from that frame's time
        self.assertEqual(self.e.picture_times(pts, edits, 1.0), [0.0, 0.1, 1.2, 1.2])
        # a frame both removed and held is only removed
        self.assertEqual(self.e.edited_sequence(pts, {1: {"removed": True, "extended": True}}, 1.0), [(0.0, 0), (0.1, 0), (0.2, 2), (0.3, 3)])
        self.assertEqual(self.e.edited_sequence([], {}, 1.0), [])

    def test_thinning_keeps_pictures_a_gap_apart(self):
        times = [i * 0.1 for i in range(10)]
        thin = self.e.rate_limited_removals
        # 0.0, 0.3, 0.6 and 0.9 stay
        self.assertEqual(thin(times, 0.25), {1, 2, 4, 5, 7, 8})
        # only frames 3 to 6 may go: the frames outside still set the pace (0.2 stays, so 0.3
        # and 0.4 go; 0.5 stays; 0.6 goes; 0.7 is not this edit's)
        self.assertEqual(thin(times, 0.25, scope={3, 4, 5, 6}), {3, 4, 6})
        # a frame already removed is no picture: it neither goes again nor spaces the others
        self.assertEqual(thin(times, 0.25, gone={0}), {2, 3, 5, 6, 8, 9})
        self.assertEqual(thin([], 0.25), set())

    def test_the_frames_of_a_violation_run_from_its_onset(self):
        from unflash.analysis import Violation

        seq = [(0.0, 0), (0.1, 1), (0.2, 2), (0.3, 3)]
        self.assertEqual(self.e.flagged_frames(seq, [Violation(0.2, 0.2, "flash", 1.0, onset=0.1, peak=0.2)]), [1, 2])
        # the same from a stored verdict, where a violation is a dict
        self.assertEqual(self.e.flagged_frames(seq, [{"start": 0.2, "end": 0.2, "onset": 0.1}]), [1, 2])
        self.assertEqual(self.e.flagged_frames(seq, [{"start": 0.3, "end": 0.3}]), [3])
        self.assertEqual(self.e.flagged_frames(seq, []), [])

    def test_a_section_shows_its_frames_up_to_its_end_and_no_further(self):
        sec = {"pts": [0.01, 0.05, 0.09, 0.13], "start": 0.0, "end": 0.12}
        rel, n_out, total, base, med = self.e.section_timeline(sec)
        self.assertEqual(n_out, 3)
        self.assertAlmostEqual(total, 0.12, places=9)
        self.assertAlmostEqual(base, 0.01, places=9)
        self.assertAlmostEqual(med, 0.04, places=9)
        self.assertEqual(len(self.e.shown_pts(sec)), 3)
        self.assertAlmostEqual(rel[1], 0.04, places=9)
        # a section never prepared has no frames, and is as long as it says
        self.assertEqual(self.e.section_timeline({"pts": None, "start": 2.0, "end": 5.0}), ([], 0, 3.0, 0.0, 1.0 / 30))
        # one whose frames all lie past its end shows them all rather than nothing
        self.assertEqual(self.e.section_timeline({"pts": [1.0, 1.1], "start": 0.0, "end": 0.5})[1], 2)


@needs_numpy
class Sections(unittest.TestCase):
    """(the cases of crates/unflash-core/src/sections.rs and timeline.rs)"""

    def setUp(self):
        from unflash import analysis, config, ffio

        self.a = analysis
        self.ffio = ffio
        self.ext, self.wcag, self.strict = (config.profile_config(p) for p in ("wcag_ext", "wcag", "strict"))

    def test_the_rate_no_profile_can_fail(self):
        a = self.a
        self.assertEqual([a.flash_window_frames(c) for c in (self.ext, self.wcag, self.strict)], [4, 6, 4])
        self.assertEqual([a.safe_picture_rate(c)[0] for c in (self.ext, self.wcag, self.strict)], [3.80, 5.71, 3.80])
        fps, gap = a.safe_picture_rate(self.ext)
        self.assertAlmostEqual(gap, 1 / fps)
        self.assertTrue(a.rate_is_guaranteed(self.ext, 3.8))
        self.assertFalse(a.rate_is_guaranteed(self.ext, 3.81))

    def test_how_much_of_what_came_before_a_check_must_see(self):
        self.assertEqual(self.a.context_seconds(self.ext), 6.5)
        self.assertEqual(self.a.context_seconds(self.wcag), 4.5)

    def test_sections_are_padded_from_the_onset_merged_when_close_and_split_when_long(self):
        V = self.a.Violation
        vs = [V(10.0, 10.5, "flash", 1.0, onset=9.2), V(12.0, 12.2, "red", 1.0, onset=12.0), V(30.0, 30.1, "extended", 1.0, onset=30.0)]
        secs = self.a.violations_to_sections(vs, self.ext, (0.0, 100.0))
        self.assertEqual(len(secs), 2)
        # 1.5 s before the onset at 9.2 s, 1.5 s after the end at 12.2 s
        self.assertAlmostEqual(secs[0]["start"], 7.7, places=6)
        self.assertAlmostEqual(secs[0]["end"], 13.7, places=6)
        self.assertEqual(secs[0]["kinds"], ["flash", "red"])
        self.assertEqual(secs[1]["kinds"], ["extended"])
        # with keyframes, a section starts and ends on one
        snapped = self.a.violations_to_sections(vs, self.ext, (0.0, 100.0), keyframes=[0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0])
        self.assertEqual([(x["start"], x["end"]) for x in snapped], [(5.0, 15.0), (25.0, 35.0)])
        # a profile that does not report extended flashes makes no section for one
        self.assertEqual(len(self.a.violations_to_sections(vs, self.wcag, (0.0, 100.0))), 1)
        # a hundred seconds of flashing is three sections of 45 s at most
        self.assertEqual(len(self.a.violations_to_sections([V(0.0, 100.0, "flash", 1.0)], self.ext, (0.0, 200.0))), 3)
        self.assertEqual(self.a.violations_to_sections([], self.ext, (0.0, 100.0)), [])

    def test_sections_snap_outward_to_keyframes_inside_the_video(self):
        snap = self.ffio.snap_to_keyframes
        kf = [0.0, 2.0, 4.0, 6.0]
        self.assertEqual(snap(kf, 2.5, 3.5, (0.0, 10.0)), (2.0, 4.0))
        # past the last keyframe: to the end of the video
        self.assertEqual(snap(kf, 5.0, 9.0, (0.0, 10.0)), (4.0, 10.0))
        self.assertEqual(snap([], 5.0, 9.0, (0.0, 10.0)), (5.0, 9.0))
        # an end before its start runs to the end
        self.assertEqual(snap([], 9.0, 5.0, (0.0, 10.0)), (9.0, 10.0))
        # already on keyframes: where it is
        self.assertEqual(snap(kf, 2.0, 4.0, (0.0, 10.0)), (2.0, 4.0))

    def test_frame_times_that_jump_are_bridged_by_the_usual_step(self):
        fix = self.ffio.sanitize_deltas
        out, fixed = fix([0.0, 0.04, 0.08, 0.02, 9.0, 9.04], 5.0)
        self.assertEqual(fixed, 2)
        for got, want in zip(out, [0.0, 0.04, 0.08, 0.12, 0.16, 0.20]):
            self.assertAlmostEqual(got, want, places=9)
        # from where the times start; a jump before any good step is bridged by a 30th of a second
        out, fixed = fix([3.5, 1.0, 1.04], 5.0)
        self.assertEqual(fixed, 1)
        for got, want in zip(out, [3.5, 3.5 + 1 / 30, 3.5 + 1 / 30 + 0.04]):
            self.assertAlmostEqual(got, want, places=9)
        self.assertEqual(fix([], 5.0), ([], 0))
        # the same rule as an ffmpeg filter, for the spans ffmpeg re-encodes by itself
        expr = self.ffio.sanitize_setpts(5.0, 1 / 30)
        self.assertTrue(expr.startswith("setpts=if(eq(N\\,0)\\,0\\,PREV_OUTPTS+"))
        self.assertIn("5.000000/TB", expr)
        self.assertIn("0.033333/TB", expr)

    def test_the_analysis_size_fits_the_wcag_screen_at_a_quarter(self):
        dims = self.ffio.analysis_dims
        self.assertEqual(dims(1920, 1080, self.ext), (256, 144))
        self.assertEqual(dims(1024, 768, self.ext), (256, 192))
        # a tall picture is fitted by its height; sizes are kept even, and two at least
        self.assertEqual(dims(1080, 1920, self.ext), (108, 192))
        self.assertEqual(dims(4000, 2, self.ext), (256, 2))
        full = type(self.ext)(analysis_scale=1.0)
        self.assertEqual(dims(1920, 1080, full), (1024, 576))


class Jobs(unittest.TestCase):
    def setUp(self):
        from unflash.jobs import Job, JobManager

        self.Job = Job
        self.JobManager = JobManager

    def test_a_job_runs_to_its_result_and_says_how_far_it_is(self):
        def work(job):
            job.set_progress(0.4, "part way")
            self.assertEqual((job.status, job.progress, job.message), ("running", 0.4, "part way"))
            job.set_progress(7)
            self.assertEqual(job.progress, 1.0)
            job.set_progress(-1)
            self.assertEqual((job.progress, job.message), (0.0, "part way"))
            return {"frames": 3}

        job = self.Job("scan", work)
        self.assertEqual(job.status, "queued")
        job.run()
        self.assertEqual((job.status, job.progress, job.result, job.error), ("done", 1.0, {"frames": 3}, None))
        self.assertIsNotNone(job.finished)
        d = job.to_dict()
        self.assertEqual((d["id"], d["name"], d["status"], d["result"]), (job.id, "scan", "done", {"frames": 3}))

    def test_a_job_that_fails_or_is_cancelled_says_so(self):
        import contextlib
        import io

        def fails(job):
            raise ValueError("no such section")

        job = self.Job("check", fails)
        # (the traceback goes to the server's log)
        with contextlib.redirect_stderr(io.StringIO()):
            job.run()
        self.assertEqual((job.status, job.error, job.result), ("error", "no such section", None))
        stopped = self.Job("render", lambda job: job.cancel())
        self.assertFalse(stopped.cancelled())
        stopped.run()
        self.assertEqual(stopped.status, "cancelled")

    def test_the_manager_runs_jobs_in_the_background_and_finds_them_again(self):
        jm = self.JobManager()
        go = threading.Event()
        job = jm.start("slow", lambda job: go.wait(5) and "done")
        self.assertIs(jm.get(job.id), job)
        self.assertIsNone(jm.get("no such job"))
        self.assertEqual(jm.active(), [job])
        go.set()
        for t in threading.enumerate():
            if t.name == "job-slow":
                t.join(5)
        self.assertEqual((job.status, job.result), ("done", "done"))
        self.assertEqual(jm.active(), [])


if __name__ == "__main__":
    unittest.main()
