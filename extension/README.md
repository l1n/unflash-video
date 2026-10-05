# Unflash for the browser: the video flash guard

A browser extension that runs Unflash's detector on every video you watch
as it plays (YouTube, Vimeo, Twitch, news sites, an embedded player, any
HTML5 `<video>`). When a video starts flashing, it hides the flashing until
it has stopped for a second. It looks at each picture as it is shown, and
nothing leaves your machine.

**This reduces risk. It is not a guarantee.** It has no lookahead: it
judges each picture as the video shows it, so the first moment of
flashing (one or two swings of brightness, about a tenth of a second at
the default setting) is on screen before the guard steps in. If you need a
video to be safe from its first frame, scan and fix it with the web app.
See [Limitations](#limitations).

## What it does

For each `<video>` that plays and is shown at least 96×54 px:

1. Each picture goes to the detector as it is shown, and is timed by the
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
4. Then it does what you chose:
   - **Hold the picture** (the default). It keeps a small copy of a picture
     every tenth of a second, and shows the last one from at least 0.3 s
     before the first swing over the video until the flashing stops. This is
     the same idea as the web app's fix (a calm frame held in place of the
     flashing ones), done as the video plays. The video and its sound keep
     playing underneath. If no calm picture was kept from that long before,
     or the video is full screen on its own, where nothing can go over it,
     the video is dimmed instead.
   - **Dim**: a CSS filter (`contrast(0.5) brightness(0.35) saturate(0.2)`)
     that keeps any swing of brightness under WCAG's 0.1 and washes the red
     out of red flashes.
   - **Pause**: pauses the video, and says why until you play it again.
   - **Only say so**: a badge over the video, nothing more.
5. The video comes back a second after the last swing that kept the
   flashing going.

Hazardous **stripe patterns**, which the default profile flags, are blurred
while they are on screen (in every mode but *Only say so*).

The toolbar button counts the times flashing was stopped on the page, and
shows **!** while it is being stopped. Its popup has the settings: on or
off (also **Alt+Shift+U**), on or off for the site you are on (the tab's
site, which covers the players it embeds), the mode, the sensitivity, the
profile (the web app's three) and the detector.

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

- the hold starts within the first few tenths of a second of the flashing,
  shows the calm picture from before it (the middle pixel is read off a
  screenshot), and ends within a second of the flashing's end;
- dim dims, then puts the video's own filter back;
- pause pauses, and says so until the video is played again;
- a site that is switched off is left alone;
- a video from another site, sent without CORS, is reported as unreadable;
- the GPU detector works too.

## Limitations

- **No lookahead.** The first flash or two are seen before the guard steps
  in. It cannot know what the next picture will be.
- **Pictures it cannot read**: a video from another site sent without CORS
  headers (the browser keeps its pixels from the page; the popup says how
  many such videos there are), and DRM-protected video (Netflix, Disney+,
  Prime Video and the like), which reads as black. YouTube, Vimeo, Twitch
  and most players stream through Media Source Extensions or with CORS, and
  can be read.
- Videos inside a **closed shadow root**, or drawn on a canvas by the page
  rather than shown in a `<video>`, are not seen.
- **Holding a picture** stops the motion while the sound goes on, as the web
  app's fix does. The held picture is a copy at most 640 pixels wide.
- A detector per playing video costs memory (the WebAssembly, 2.7 MB, once
  per page or frame that plays a video, and about 15 MB of kept pictures
  per video in *hold* mode) and some time per picture.
- Not yet tested in Firefox or Safari. Safari would need the extension
  converted with Xcode's `safari-web-extension-converter`.
