# What's new in Unflash

The changes you would notice in the web version, newest first. When you come
back to the app, it shows you the ones made since your last visit (the
*What's new* button in the header has them all).

<!-- For whoever adds to this: one line per change, under the day it goes
live (UTC), starting with the time it goes live as a comment. The app
compares that time with the visitor's last visit, so write it for every
line. Say what someone using the app will see; leave out tests and
internals. -->

## 2026-09-23

- <!-- 01:00 --> **Fewest removals don't freeze the picture.** Where taking the flashing out would still leave a picture frozen for half a second or more, some frames come back into that stretch at 3.8 a second (a rate that can't flash by itself), each try checked. **Auto-fix** now tries the fewest removals first, then keep dark, keep light and reduce FPS.
- <!-- 00:40 --> **What's new** (this list): when you come back, the changes since your last visit are waiting on the start page, and the *What's new* button in the header has them all.
- <!-- 00:40 --> **🐞 debug info**, bottom right: what your browser, GPU and video are and how long each job took (a scan step by step), ready to paste into a message when something is slow or goes wrong. It names no files.
- <!-- 00:08 --> **Lower contrast instead of removing frames.** *Suggest: lower contrast* blends the flashing frames with the frames either side of them, as little as passes the check (and a bit more, to be safe). No frame is taken out and the timing stays. Mark frames yourself with **B**; the *blend* slider, shown once a section has B marks, sets how far (80% to begin with). The section player and the export show exactly what was checked. Where something moves, a blended frame shows a faint ghost of it.

## 2026-09-22

- <!-- 23:45 --> **Long files scan faster.** An hour-long scan spent about half a minute redrawing the timeline as it went; now it takes a fraction of a second.
- <!-- 23:19 --> **Bigger thumbnails, and any frame at full size.** Thumbnails come in four sizes (S to XL, remembered). **Z**, a double-click or *view frame* shows the selected frame at full size, to read a subtitle or look closer. The arrow keys step through the frames (with shift, ten at a time) and the mark keys work on the frame in view. So that stepping through flashing doesn't flash, a new picture shows at most every 0.4 s.
- <!-- 23:09 --> **Suggest: fewest removals.** Takes out whichever of the light or dark frames are fewer, then puts back as many flashes as the rules allow (no more than three a second). On the test clip it removes 59 frames where *keep dark* removes 80.
- <!-- 22:59 --> **Faster in Firefox.** Scans, prepares and checks decode in the background, several pictures at once, instead of on the page (which held Firefox to about 190 frames a second).
- <!-- 22:50 --> **MKV and WebM files open**, with H.264, HEVC, VP9, AV1 or VP8 video. Audio an MP4 can hold is copied into the export; Vorbis and PCM are converted (to AAC, or Opus). Subtitles and extra audio tracks are left out, and the app says so. AVI, TS, FLV, WMV, MPEG-PS and Ogg files are recognised, with how to convert them.
- <!-- 22:23 --> **A beep when a long job finishes** (one that ran for over a minute; change it under the 🔔 in the header), a system notification too if you allow it, and the job's progress in the tab's title.
- <!-- 22:23 --> **Work carries on in a background tab.** Scans, prepares and exports no longer stall when the tab isn't in front.
- <!-- 22:23 --> **Sections prepare faster**: their frames are decoded in several pieces at once. Firefox on a Mac skips a colour conversion on every frame.
- <!-- 20:22 --> **H.264 exports from Firefox on Windows work** (they failed with "invalid H.264 data"). The export dialog offers one choice per format and says where each plays and whether the parts you didn't edit are copied.
- <!-- 20:04 --> **The guide opens beside your work** instead of hiding it; the *Guide* button, its close button or Esc put it away.
- <!-- 20:04 --> **The section player.** With a section open, the player plays that section with your marks applied, exactly as the export will write it, or as it was: from the selected frame, looping if you like, at full, half or quarter speed. It starts small and dimmed, and the line above it says what's on screen and whether that passes.
- <!-- 20:04 --> **Editing works like the original tool.** **R**, **F** and **E** put their mark on and take it off again; **K** (new) keeps a frame out of the suggestions' reach, for a subtitle or an image that matters; **U** clears; **Ctrl+Z** and **Ctrl+Shift+Z** undo and redo any change, suggestions included. *Reduce FPS* starts at twice the always-safe rate and steps down until the check passes, keeping as many pictures as it can; its ▾ menu thins to a rate you type.
- <!-- 20:04 --> **Auto-fix is off unless you tick it** (and remembered). The scan still starts when you open a file, and a section prepares itself when you open it.
- <!-- 02:27 --> **Exports copy what you didn't touch.** Only the stretches around the sections are decoded and re-encoded, several at once; the rest is copied from your file as it is, so exports are much faster and the untouched parts lose nothing.
- <!-- 00:28 --> **Faster scans.** Frames go to the GPU in batches, and a long file is scanned in up to four parts at once.

## 2026-09-21

- <!-- 23:34 --> **Feature-length films.** Exports are written to disk as they are made instead of being held in memory, and sections use less memory. The live monitor reads the finished scan rather than watching the player's frames.
- <!-- 22:34 --> **Quicker from opening to done.** The file is read once for every pass (in Firefox on a Mac each pass used to lose about a second).

## 2026-09-20

- <!-- 23:43 --> **Drop a video anywhere** on the page to open it.
- <!-- 23:37 --> **Auto-fix**: scan, fix, export and check a file with no clicks at all (now off unless you tick it).
- <!-- 23:21 --> **Red flashes that keep the brightness the same** (a saturated red swapped with a grey just as bright) are caught; the original tool missed them.
- <!-- 21:56 --> **Firefox scans faster**, sending the GPU the video's own colour planes rather than a converted picture.
- <!-- 18:31 --> **Firefox works**: a scan no longer crashes on its first frame.
- <!-- 05:32 --> **H.264 in any browser.** Where the browser can't decode H.264 itself (some Linux builds), a decoder built into the app does, several pictures at once, interlaced video included.
- <!-- 03:57 --> **Stripe patterns**: fine gratings over a quarter of the screen or more are found, and *soften stripes* blurs them just enough. The start page has test clips to try the app with.

## 2026-09-19

- <!-- 22:54 --> **The web version**: Unflash rebuilt to run in your browser, on your GPU. Your video stays on your computer; nothing is uploaded.
