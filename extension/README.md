# Unflash for the browser: the video flash guard

A browser extension that runs Unflash's detector on every video you watch
(YouTube, Vimeo, Twitch, news sites, an embedded player, any HTML5
`<video>`), and keeps its flashing off the screen. Nothing leaves your
machine.

It **looks ahead**. The video is shown a second late (0.5 or 2 s if you
prefer), with its sound delayed the same amount. Each picture is judged
as the video plays, so by the time a picture is due, the detector has
already seen the second that follows it. A stretch of flashing is
found before its first picture is shown, and from its start it is replaced
by the last calm picture before it (or dimmed, or the video is paused). None
of the flashing reaches the screen. The test shows this: it reads the screen
throughout a video that flashes for three seconds, and never sees a flashing
picture. Reacting as the video plays instead (lookahead off), the same test
does see the first moment of flashing.

**This reduces risk. It is not a guarantee.** See
[Limitations](#limitations).

## What it does

For each `<video>` that plays and is shown at least 96×54 px:

1. Each picture is copied (at the size it is shown, at most 720p) and goes
   to the detector as the video plays. The copy is shown over the video
   when it is due, `lookahead` seconds later. Each picture is timed by the
   wall clock rather than the video's own clock: a video played at twice
   the speed flashes twice as fast for whoever watches it.
2. The guard counts **swings**: a large enough part of the picture
   (the detector's area threshold, a quarter of a 341×256 window at 1024×768)
   getting brighter, darker, redder or less red by enough to count (the
   profile's swing, 0.1 of relative luminance under WCAG). It also reads the
   detector's own verdict on each picture: flashing past the limit (general
   or red), and, under the default profile, flashing at the limit.
3. It steps in at the **sensitivity** you choose:
   - *at the first flash*: two swings within a second;
   - *at the second* (the default): three swings within a second;
   - *only past the limit*: once the detector finds flashing that breaks the
     profile's limit (more than 3 flashes a second over enough of the picture),
     or flashing at the limit under the default profile.
4. The flashing is taken to start 0.3 s before its first counted swing (a
   swing is counted a little after it starts, and the change before it may
   have been too small to count), and to end a second after the last swing
   that kept it going. With a 1 s lookahead, at the default sensitivity,
   that stretch is known before its first picture is due: flashing at
   the limit (3 flashes a second, a swing every sixth of a second) makes its
   third swing about a third of a second after its first.
5. The pictures in that stretch are shown as you chose:
   - **Hold the picture** (the default): the last picture from before the
     stretch, in place of each of its pictures. This is what the web app's
     fix does (a calm frame held in place of the flashing ones). The sound
     goes on.
   - **Dim**: each picture with a filter (`contrast(0.5) brightness(0.35)
     saturate(0.2)`) that keeps any swing of brightness under WCAG's 0.1 and
     washes the red out of red flashes.
   - **Pause**: the video is paused as soon as the flashing is found, and
     the last calm picture stays on screen until you play it again.
   - **Only say so**: a badge over the video, nothing more. With lookahead,
     it comes up before the flashing does.

Without lookahead (or where it can't be used, see below), the same happens
as the video plays: the hold uses a small picture kept every tenth of a
second, and the dim and blur go on the video itself. The first moment of
flashing (two or three swings, about a tenth of a second at the default
sensitivity) is on screen before the guard steps in.

Hazardous **stripe patterns**, which the default profile flags, are blurred
while they are on screen (in every mode but *Only say so*).

The toolbar button counts the times flashing was stopped on the page, and
shows **!** while it is being stopped. Its popup has the settings: on or
off (also **Alt+Shift+U**), on or off for the site you are on (the tab's
site, which covers the players it embeds), the mode, the sensitivity, the
profile (the web app's three) and the detector.

### When it can't look ahead

The late copy goes over the video, so the video is shown as it plays
(the guard reacting, not looking ahead) when:

- the video is **full screen on its own**, or in **picture-in-picture**,
  where nothing can go over it (a player that puts its whole frame full
  screen, as YouTube does, is fine);
- its **sound can't be delayed**. The sound is taken through Web Audio
  (`createMediaElementSource` and a `DelayNode`). A page that has had no
  click or key yet may not start sound, so a video with sound is shown on
  time until you click the page (the popup says so). A muted video, such as
  an autoplaying preview, is shown late at once. A page that takes the
  element's sound into its own Web Audio graph keeps it, and its video is
  shown on time.

## How it runs

The content script (`src/content.js`) is in every page and frame. It loads
the guard (`src/guard.js`), and the guard loads the WebAssembly only once a
video plays. The detector is the web app's own: `web/detector.js` (with
`web/frames.js` and `web/profile.js`) and the WebAssembly in `web/pkg`,
copied in by `build.mjs`. The settings are in `src/settings.js`, the
toolbar button in `src/background.js`, and the popup in `src/popup.*`.

- **GPU** (Chrome, Edge, Opera): the WebGPU detector, one picture per
  submission, fed the `<video>` element itself, a copy on the graphics card.
  This takes about 1 ms of the page's time per picture.
- **CPU**: the SIMD detector, fed the picture drawn on a canvas at twice the
  detector's size (512×288 for 16:9). A verdict comes back at once.
- *Automatic* picks the GPU, unless the GPU's verdicts come back more than
  150 ms late on average (Firefox's WebGPU runs in another process, about
  300 ms away, and a software adapter is slower still). It then switches
  to the CPU for that video, since a late verdict is no use to a guard.
  In Firefox it starts on the CPU.

The guard watches a video only while it plays, through
`requestVideoFrameCallback` (with an animation-frame fallback). It lets go
when the video leaves the page, and starts its detector afresh after ten
minutes without a swing, since the detector keeps every picture's numbers.

Looking ahead, the copies are kept for the lookahead and a little more,
drawn at the size the video is shown, at most 1280×720 (about 3.7 MB each:
110 MB of graphics memory for a 30 fps video a second ahead, twice that at
60 fps). The one due is drawn every animation frame.

What goes over the video is an element put right after it, in the same
container. It covers the video and stays under the player's own controls and
captions, which come later in the page. It has a closed shadow root so the
page's styles don't reach it, and lets every click through.

## Building and installing

```
./build.sh                      # the WebAssembly (web/pkg), as for the web app
node extension/build.mjs        # extension/build/chrome, extension/build/firefox, and a .zip of each
```

- **Chrome, Edge, Opera, Brave**: go to `chrome://extensions`, turn on
  *Developer mode*, choose *Load unpacked*, and pick `extension/build/chrome`.
- **Firefox** (128 or later): go to `about:debugging#/runtime/this-firefox`,
  choose *Load Temporary Add-on…*, and pick
  `extension/build/firefox/manifest.json`. A permanent install needs the zip
  signed by Mozilla.

CI builds both zips on every push (the *extension* artifact of the CI
workflow).

## Testing

```
node extension/test/e2e.mjs     # after the two builds above; needs ffmpeg and Playwright's Chromium
```

The test loads the Chrome build into headless Chromium. The page plays a
canvas through a `<video>` (calm, then 3 s of the whole picture flashing at
7.5 flashes a second, then calm) and a WebM made by ffmpeg the same way. The
test checks that:

- looking ahead, the middle of the video, read off screenshots as fast as
  they can be taken (over a hundred looks), never shows the flashing:
  holding (the calm picture shown instead), dimming (only dimmed), or
  pausing (paused before any of it). The same looks without lookahead do
  catch the flashing's first moment, so the looks can see it;
- a video with sound is shown late, its sound delayed;
- in a page laid out like YouTube's player (the video streamed through
  Media Source Extensions from a `blob:` URL, placed in its container, the
  player's controls over it), no flashing is seen, and the late copy stays
  under the controls;
- reacting as it plays: the hold starts within the first few tenths of a second of the flashing,
  shows the calm picture from before it (the middle pixel is read off a
  screenshot), and ends within a second of the flashing's end;
- dim dims, then puts the video's own filter back;
- pause pauses, and says so until the video is played again;
- a site that is switched off is left alone;
- a video from another site, sent without CORS, is reported as unreadable;
- the GPU detector works too.

## Limitations

- **Looking ahead costs a second.** Everything you do to the video (play,
  pause, seek) shows a second later. Captions, which the player draws
  itself, run a second early. A live stream is a second further behind.
- **A video longer in flashing before it is found than the lookahead** is
  seen from where it is found: the *only past the limit* sensitivity waits
  for more than three flashes in a second, which a 0.5 s lookahead may not
  cover. The defaults (1 s, *at the second*) do.
- **Without lookahead** (switched off, or not possible: see above) the
  first flash or two are seen before the guard steps in.
- A player that uses **the browser's own controls** (`<video controls>`)
  has them covered by the late copy while looking ahead. They still take
  clicks and keys. YouTube, Vimeo, Twitch and most sites draw their own,
  which stay on top.
- **Pictures it cannot read**: a video from another site sent without CORS
  headers (the browser keeps its pixels from the page; the popup says how
  many such videos there are), and DRM-protected video (Netflix, Disney+,
  Prime Video and the like), which reads as black. YouTube, Vimeo, Twitch
  and most players stream through Media Source Extensions or with CORS, and
  can be read.
- Videos inside a **closed shadow root**, or drawn on a canvas by the page
  rather than shown in a `<video>`, are not seen.
- **Holding a picture** stops the motion while the sound goes on, as the web
  app's fix does.
- A detector per playing video costs memory: the WebAssembly (2.7 MB) once
  per page or frame that plays a video, the copies kept to look ahead (see
  above), and some time per picture.
- Not yet tested in Firefox or Safari. Safari would need the extension
  converted with Xcode's `safari-web-extension-converter`.
