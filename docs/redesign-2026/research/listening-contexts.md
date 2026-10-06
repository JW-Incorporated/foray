# UX for audio apps across listening contexts: implications for 4a Now Playing, mini player and queue

Redesign 2026, Phase 1 research. Feeds `../design-brief.md`.

Sources fetched for this write-up are marked **[F]**. Items marked **[K]** come
from the researcher's own knowledge and were not re-fetched; verify them before
they go in a spec. Internal sources are in `docs/brief/`.

## 1. What our own brief already says (internal)

- `docs/brief/01_PROMPT.md` line 24: "every action reachable while driving must
  work eyes-free via voice or lock-screen/steering-wheel controls. Big tap
  targets on the session picker. No interaction may *require* reading the screen
  while playing."
- `docs/brief/01_PROMPT.md` line 36: CarPlay is applied for early but never
  blocks a milestone. Lock screen and Bluetooth AVRCP controls ship first.
- `docs/brief/04_VOICE_AUDIO_SPEC.md` line 11: MPNowPlayingInfoCenter is fully
  populated per item. MPRemoteCommandCenter carries play/pause, a ±15/30 s seek,
  nextTrack = next queue item, and prevTrack = restart or previous. "This is the
  baseline hands-free interface."
- `docs/brief/04_VOICE_AUDIO_SPEC.md` line 8: a Bluetooth route drop pauses
  immediately (the car was switched off). Auto-resume on a car Bluetooth
  reconnect is a setting, on by default.
- `docs/brief/04_VOICE_AUDIO_SPEC.md` line 46: "The screen is for parked
  moments... don't build interaction patterns that tempt glancing."
- Hard limits in `../PLAN.md`: 44px tap targets, focus management in sheets, one
  reduced-motion block, WCAG AA contrast.

## 2. Listening contexts and what each demands

| Context | Constraint | Design consequence |
|---|---|---|
| Driving | Eyes on road, glance of about 1-2 s, vibration, one thumb or steering wheel | Playback never depends on the screen. Transport lives in OS surfaces. If the phone screen is shown, it is a glance card: title, artwork, one large play/pause. |
| Walking, one-handed | Thumb reach, sun glare, pocket mis-taps | Primary controls in the bottom third. Generous skip back and skip forward. Every swipe or gesture has a button equivalent. Accidental-touch protection on the mini player. |
| At home | Full attention, two hands, long sessions | Full Now Playing: chapters, show notes, queue editing, speed, sleep timer. |
| Headphones, pocket | Controls only on the earbud buttons, lock screen and notification | Media-session handlers must be complete (see section 3). |

Apple's CarPlay guidance
[F: https://developer.apple.com/design/human-interface-guidelines/carplay]
stresses glanceability and minimal text, large touch targets with spacing, a
shallow browse hierarchy (about 2-3 levels), and driver safety over feature
density. The fetched summary was thin, so confirm exact numbers in the HIG
before quoting them.

Android's car-media docs
[F: https://developer.android.com/training/cars/media] state that the platform
renders a restricted UI for apps built on MediaBrowserService plus MediaSession.
The content tree uses FLAG_BROWSABLE and FLAG_PLAYABLE nodes, there are
driver-distraction safeguards, and voice actions are required. Apps do not draw
their own player UI there, so the car experience is determined by our metadata
and session, not our visual design.

## 3. Lock screen, notification, media session (the "other Now Playing")

For most listening time, Now Playing is not our UI. It is the OS surface fed by
our metadata.

- **Artwork:** supply multiple sizes (96, 128, 192, 256, 384 and 512 px)
  [F: https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API shows
  the artwork array with sizes and type]. Use square, high-contrast art that
  survives a small crop and a blurred lock-screen background. Use episode art,
  falling back to show art. Titles must work at 1-2 lines of 16-20 characters
  before truncation, so put the distinguishing words first.
- **Metadata:** title is the episode, artist is the show, album is the series or
  the "why picked" context. Duration and position must be set so the OS scrubber
  works: `setPositionState` in the Web Media Session API; MPNowPlayingInfoCenter
  elapsed time and rate on iOS; METADATA_KEY_DURATION on Android
  [F: https://developer.android.com/media/implement/surfaces/mobile].
- **Action handlers:** register play, pause, seekbackward, seekforward, seekto,
  previoustrack and nexttrack [F: MDN]. Map them as the brief specifies:
  previoustrack restarts the episode if more than a few seconds in, otherwise
  goes back; nexttrack goes to the next queue item.
- **Android notification:** Android 13+ shows up to 5 actions (3 compact),
  derived from player state, with custom buttons filling the slots [F: Android
  doc above]. Slot 1 for play/pause; slots 2 and 3 for the ±skip or
  previous/next choice. Offer one custom "bookmark moment" action, since 4a
  ships bookmarks (commit 51b3c42b), with a clear label and an unambiguous icon.
- **Resumption:** Android supports a resumable last-played item in the media
  carousel via MediaBrowserService `EXTRA_RECENT` [F: Android doc]. The iOS
  counterpart is the Now Playing widget retaining the last item. Both match the
  brief's "resume on reconnect".
- **Bluetooth and steering wheel:** these send next/previous and play/pause only.
  Navigation must not require seek-by-skip. Never gate resume on a screen tap.
- **CarPlay and Android Auto:** treat the in-car UI as a template output, not a
  design canvas. Provide a browse tree of at most 2-3 levels (for example Today
  picks, Queue, Recent), large artwork and voice hooks. Per the brief, ship lock
  screen and AVRCP first and CarPlay later.

## 4. Accessibility for audio apps

- **Tap targets:** WCAG 2.2 SC 2.5.8 sets a minimum of 24 CSS px, with
  exceptions for spacing, inline links and similar
  [F: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html]. The
  enhanced level (SC 2.5.5, AAA) is 44 px. Apple's HIG recommends 44 pt
  [F: https://developer.apple.com/design/human-interface-guidelines/accessibility].
  Our 44 px floor is correct. Use 56 px or more for play/pause and the skip
  buttons, and 12 px or more between adjacent transport controls so mis-taps
  stay rare when walking.
- **Dynamic Type and text scaling:** the layout must hold at the largest
  accessibility sizes [F: HIG accessibility, summary]. Now Playing needs a
  layout that reflows: artwork shrinks, the title wraps to up to 3 lines, the
  scrubber time labels stack. Use rem units and `clamp`; never fix a height on a
  text container. The "no zoom" ruling is open to challenge: pinch-zoom-off
  breaks WCAG 1.4.4 resize and 1.4.10 reflow [K]. A direction keeping it must
  justify it.
- **Screen readers (VoiceOver, TalkBack):**
  - The mini player is one landmark with a clear label ("Now playing: title,
    show"). Play/pause exposes its state ("Pause", not "button").
  - The scrubber is an adjustable slider with a spoken value ("12 minutes 30 of
    48 minutes") and increments by the skip interval. Do not update the live
    value every second; that floods the screen reader.
  - Queue reordering needs non-drag alternatives: move up, move down, remove, as
    custom actions or buttons [K, WCAG 2.5.7 Dragging Movements].
  - Sheets trap and restore focus (already a hard limit). The Now Playing sheet
    announces open and close and returns focus to the mini player.
- **Reduced motion:** honour `prefers-reduced-motion` and iOS Reduce Motion
  [F: HIG accessibility]. Replace the artwork-expand transition, marquee titles
  and waveform animation with fades or static states. One block covers all (a
  hard limit).
- **Contrast:** 4.5:1 for normal text and 3:1 for large text and UI components
  (WCAG 1.4.3, 1.4.11) [F: HIG cites 4.5:1]. On artwork-tinted backgrounds,
  compute contrast for text over the tint at runtime or fall back to a safe
  scrim. Dark-only helps, but light-on-art needs the scrim anyway. Never signal
  state by colour alone (played, queued, downloaded).
- **Audio-specific:** captions or transcripts where available, a speed control
  with a clear spoken value, and a sleep timer. Haptics on skip and bookmark
  confirmations help eyes-free use. Honour the system "mono audio" and "reduce
  loud sounds" settings without fighting them [K].

## 5. Reading show notes

Show notes are read parked or at home, rarely while moving.
- Put them below the transport, never in its way. A collapsed default (about 4
  lines plus "More") keeps Now Playing scannable [K].
- Sanitize feed HTML (`esc()` and `safeUrl()` apply). Render headings, lists and
  links in our type scale, not the feed's styles. Links are 44 px targets and
  open outside the player.
- Timestamps in the notes should be tappable and seek in place. The deep link
  `#/episode/<id>?t=N` already exists (commit b96c5780); use the same
  affordance, as a chip with a visible time.
- Readable line length (about 45-75 characters), line height of at least 1.5,
  and text that scales. Provide a chapters list when the feed has one, above the
  free text.
- Copy rules apply: our own why-line (18 words or fewer) sits above the feed's
  notes, and feed text is never rewritten (legally boring).

## 6. Concrete design implications

### Now Playing

1. **Two modes from one layout.** Glance mode (default while playing, also the
   car posture): artwork, title and show on at most 2 lines each, a single
   oversized play/pause (72 px or more), skip back 15 and skip forward 30 at 56
   px or more, and a thick scrubber. Nothing else competes. Detail mode (scroll
   or expand): chapters, speed, sleep timer, bookmark, show notes, queue peek.
2. **Controls in the thumb zone.** Transport in the lower third. Secondary items
   (speed, timer, share) in one row of 44 px or larger buttons, with labels
   visible at large text sizes.
3. **Scrubber:** a hit area 44 px or taller on a thin visual track, an adjustable
   accessible slider, time labels and chapter ticks. Dragging shows a large time
   bubble. Skip buttons cover the common case, so fine scrubbing is optional.
4. **No required reading while playing.** Never put a confirmation or choice
   inline that demands a glance. Any prompt (for example a "why this pick" panel)
   is optional and auto-dismissed.
5. **Artwork:** large and tinted, with a contrast-safe scrim. Prepare the six
   media-session sizes from the same source.
6. **A reduced-motion variant** of every transition, and a layout verified at
   maximum text scale.

### Mini player

1. **Height of 64 px or more, with play/pause at 48 px or more** at the right
   edge, plus skip forward as a second button. Tapping the body opens Now
   Playing, so the body must not overlap the buttons.
2. **Always reachable above the tab bar, never covered by content.** A thin
   progress line, decorative and hidden from screen readers (the full slider
   lives in Now Playing).
3. **Walking protection:** swipe-to-dismiss must be a deliberate gesture with
   undo, distinct from scrolling. Offer an equivalent "Stop" in the sheet.
4. **Accessible name** "Now playing: title, show", with state-aware play/pause.
   No marquee scrolling under Reduce Motion (static truncation).

### Queue

1. **Reorder without dragging:** a drag handle plus move up/down and remove via
   accessible actions. Swipe actions have button equivalents. Undo toast for
   removals.
2. **Row layout:** rows 56 px or taller, artwork thumbnail, title (2 lines), show,
   remaining duration. The "now" row is distinguished by a non-colour cue (an
   icon plus label).
3. **Continuous playback stays on** (founder ruling 2026-09-14). Show the next
   item as "Up next" in glance mode and in the OS metadata. Automatically
   appended items follow the 30% exploration floor and carry their bridge line
   in the queue row, as the copy rules require.
4. **Shallow structure:** queue, history and saved are one level each. This
   matches the 2-3 level limit CarPlay and Android Auto impose, so the same tree
   can feed those surfaces later.
5. **Eyes-free parity:** every on-screen queue action has a voice or session
   equivalent (next, previous, "something different", "save for later") per the
   brief.

### Platform-wide

- Treat the media session as a first-class screen. Write acceptance tests for the
  metadata, the action handlers and the position state, and test on a real
  Android device (Joey) and an iPhone (Wyatt). Bluetooth route-change behaviour
  must be tested in a real car, as the audio spec says.
- Make the "car posture" decision explicit in each direction: does a
  larger-control glance mode appear automatically (for example on a car
  Bluetooth route), or only by user toggle? "State observed, never declared"
  suggests observing the route. That is the owner's call at the pick.

## 7. Open points and caveats

- The Apple HIG fetches returned condensed summaries. Check exact numbers
  (CarPlay row limits, Dynamic Type category counts) in the primary pages before
  putting them in a spec.
- WCAG items marked [K] (1.4.4, 1.4.10, 1.4.11, 2.5.7) are from memory; confirm
  at https://www.w3.org/TR/WCAG22/.
- CarPlay audio entitlement approval takes weeks (brief). Treat all CarPlay
  design as a later phase.

## Sources

- https://developer.android.com/training/cars/media
- https://developer.android.com/media/implement/surfaces/mobile
- https://developer.apple.com/design/human-interface-guidelines/carplay
- https://developer.apple.com/design/human-interface-guidelines/accessibility
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API
- https://www.w3.org/TR/WCAG22/
- Internal: `docs/brief/01_PROMPT.md`, `docs/brief/04_VOICE_AUDIO_SPEC.md`,
  `docs/redesign-2026/PLAN.md`
