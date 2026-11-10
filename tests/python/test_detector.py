"""The reference detector (unflash/analysis.py) against its own fixtures.

tests/fixtures/*.json is what the detector saw in the scenes of
tests/gen_fixtures.py when the fixtures were last made, and what the Rust
port is held to (crates/unflash-core/tests/reference_fixtures.rs). Here the
detector is run over the same scenes again and must still see the same: a
change to it that moves a number shows up here, and the fixtures are then
made again on purpose (python3 tests/gen_fixtures.py), not found stale.

    python3 -m unittest discover -s tests/python

Needs numpy.
"""
import json
import os
import sys
import unittest
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

FIXTURES = os.path.join(ROOT, "tests", "fixtures")
REQUIRED = os.environ.get("UNFLASH_REQUIRE_NUMPY")


def close(a, b, tol):
    return abs(a - b) <= tol


@unittest.skipIf(np is None and not REQUIRED, "numpy is not installed")
class Fixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import gen_fixtures
        from unflash.analysis import FlashDetector
        from unflash.config import profile_config

        cls.gen = gen_fixtures
        cls.FlashDetector = FlashDetector
        cls.profile_config = staticmethod(profile_config)

    def run_scene(self, ts, frames, profile):
        """The detector over a scene, as gen_fixtures.run feeds it: what it saw."""
        g = self.gen
        det = self.FlashDetector(self.profile_config(profile), g.W, g.H)
        held = []
        crc = 0
        for t, fr in zip(ts, frames):
            fr = np.ascontiguousarray(fr)
            crc = zlib.crc32(fr.tobytes(), crc)
            before = det.held
            det.feed(t, fr)
            held.append(int(det.held - before))
        return det, det.finish(), held, crc & 0xFFFFFFFF

    def test_every_fixture_has_its_scene_and_every_scene_its_fixture(self):
        want = sorted(f"{name}_{profile}.json" for name, (_, profiles) in self.gen.SCENARIOS.items() for profile in profiles)
        have = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".json") and f != "profiles.json")
        self.assertEqual(have, want)

    def test_the_detector_still_sees_what_the_fixtures_record(self):
        checked = 0
        for name, (make, profiles) in self.gen.SCENARIOS.items():
            ts, frames = make()
            for profile in profiles:
                with self.subTest(scene=name, profile=profile):
                    with open(os.path.join(FIXTURES, f"{name}_{profile}.json")) as f:
                        fx = json.load(f)
                    det, res, held, crc = self.run_scene(ts, frames, profile)
                    # the very frames the fixture was made from
                    self.assertEqual(crc, fx["frames_crc32"])
                    self.assertEqual(ts, fx["t"])
                    # the verdict, and the picture it was reached on
                    self.assertEqual((res.safe, res.wcag_safe, res.anomalies, det.held), (fx["safe"], fx["wcag_safe"], fx["anomalies"], fx["held"]))
                    self.assertEqual((det.area_thresh, det.ww, det.wh), (fx["area_thresh"], fx["ww"], fx["wh"]))
                    self.assertEqual(held, fx["stats"]["held"])
                    # every frame's counts, to the pixel
                    st = fx["stats"]
                    for key, got in (("hazard", det.stat_haz), ("hazard_red", det.stat_haz_red), ("ext", det.stat_ext), ("ext_red", det.stat_ext_red), ("warn", det.stat_warn), ("warn_red", det.stat_warn_red), ("up", det.stat_up), ("down", det.stat_dn), ("red", det.stat_red)):
                        self.assertEqual([int(x) for x in got], st[key], key)
                    for key, got, tol in (("tc", det.stat_tc, 1e-9), ("lum", det.stat_lum, 2e-6), ("onset", det.stat_haz_onset, 1e-9), ("onset_red", det.stat_haz_red_onset, 1e-9)):
                        self.assertEqual(len(got), len(st[key]), key)
                        self.assertTrue(all(close(float(a), b, tol) for a, b in zip(got, st[key])), key)
                    # what it reports: each violation, close call and transition
                    self.assertEqual([v.kind for v in res.violations], [v["kind"] for v in fx["violations"]])
                    for v, w in zip(res.violations, fx["violations"]):
                        for key in ("start", "end", "count", "onset", "peak"):
                            self.assertTrue(close(getattr(v, key), w[key], 1e-9), (key, getattr(v, key), w[key]))
                    self.assertEqual([(w.level, w.kind) for w in res.warnings], [(w["level"], w["kind"]) for w in fx["warnings"]])
                    for v, w in zip(res.warnings, fx["warnings"]):
                        for key in ("start", "end", "count", "peak"):
                            self.assertTrue(close(getattr(v, key), w[key], 1e-9), (key, getattr(v, key), w[key]))
                    self.assertEqual([(e.kind, e.area, list(e.bbox)) for e in res.events], [(e["kind"], e["area"], e["bbox"]) for e in fx["events"]])
                    self.assertTrue(all(close(e.t, w["t"], 1e-9) and close(e.tc, w["tc"], 1e-9) for e, w in zip(res.events, fx["events"])))
                    checked += 1
        self.assertEqual(checked, len([f for f in os.listdir(FIXTURES) if f.endswith(".json") and f != "profiles.json"]))

    def test_the_profiles_file_is_the_reference_as_it_stands(self):
        with open(os.path.join(FIXTURES, "profiles.json")) as f:
            self.assertEqual(f.read(), self.gen.profiles_text())

    def test_what_the_scenes_are_for(self):
        """The verdicts the scenes were written to give, in words a reader can check."""
        seen = {}
        for f in os.listdir(FIXTURES):
            if not f.endswith(".json") or f == "profiles.json":
                continue
            with open(os.path.join(FIXTURES, f)) as fh:
                fx = json.load(fh)
            seen[(fx["name"], fx["profile"])] = (fx["safe"], sorted({v["kind"] for v in fx["violations"]}), sorted({(w["level"], w["kind"]) for w in fx["warnings"]}))
        passes = (True, [], [])
        # four flashes a second over half the picture fail WCAG; three are its limit, and pass
        self.assertEqual(seen[("square4hz", "wcag")], (False, ["flash"], []))
        self.assertEqual(seen[("square3hz", "wcag")], (True, [], [("limit", "flash")]))
        # ten seconds at the limit are an extended flash to the profile that reports those,
        # and the stricter profile, which allows two a second, fails them outright
        self.assertEqual(seen[("square3hz", "wcag_ext")], (False, ["extended"], []))
        self.assertEqual(seen[("square3hz", "strict")], (False, ["flash"], []))
        # two seconds at the limit are too short for an extended flash: a close call
        self.assertEqual(seen[("burst3hz", "wcag_ext")], (True, [], [("limit", "flash")]))
        self.assertEqual(seen[("burst3hz", "wcag")], (True, [], [("limit", "flash")]))
        self.assertEqual(seen[("burst3hz", "strict")], (False, ["flash"], []))
        self.assertEqual(seen[("red_burst3hz", "wcag")], (True, [], [("limit", "red")]))
        # a swing only the stricter profile counts: a quieter close call, and that profile's failure
        self.assertEqual(seen[("soft3hz", "wcag_ext")], (True, [], [("strict", "flash")]))
        self.assertEqual(seen[("soft3hz", "strict")], (False, ["flash"], []))
        # noise and a moving bar are no flashing; a flash that takes four frames to rise is one
        # all the same (3.75 a second)
        self.assertEqual(seen[("noise_drift", "wcag_ext")], passes)
        self.assertEqual(seen[("pan_bar", "wcag_ext")], passes)
        self.assertEqual(seen[("ramp", "wcag")], (False, ["flash"], []))
        # under a quarter of the window is too small to count; over it counts
        self.assertEqual(seen[("partial15", "wcag")], passes)
        self.assertEqual(seen[("partial35", "wcag")], (False, ["flash"], []))
        # red against a grey or a green of about its luminance: only the colour flashes.
        # Against a darker red there is one chromaticity: a luminance flash, and no red one
        for scene in ("red_grey", "red_equilum", "red_green"):
            self.assertEqual(seen[(scene, "wcag")], (False, ["red"], []), scene)
        self.assertEqual(seen[("red_darkred", "wcag")], (False, ["flash"], []))
        self.assertEqual(seen[("red_noise", "wcag_ext")], (False, ["extended", "red"], []))
        # pictures repeated (120 frames a second) and timestamps that jump change nothing
        self.assertEqual(seen[("repeat120", "wcag")], (False, ["flash"], []))
        self.assertEqual(seen[("vfr", "wcag")], (False, ["flash"], []))
        self.assertEqual(len(seen), 22)


if __name__ == "__main__":
    unittest.main()
