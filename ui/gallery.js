/* ui/gallery.js — Redesign component gallery (#/gallery).
 *
 * The route is development-only: a Lab build or an explicit ?gallery=1 query
 * may open it. Production navigation never links to it. Phase 3 task 2 starts
 * the gallery with the Tactile icon family; later foundation tasks add their
 * primitives here without putting review fixtures on listener screens.
 *
 * This is a classic script and shares app.js's globals. Nothing here runs until
 * renderCurrentPage() selects the guarded route. Listener screens do not call a
 * primitive until their Phase 4 adoption branch.
 */

function galleryEnabled() {
  return isLabBuild() || new URLSearchParams(location.search).get("gallery") === "1";
}

function galleryBandSegments() {
  return [
    { showId: "origin", show: "Origin Stories", duration: 420 },
    { showId: "narration", show: "4a narration", duration: 36, narration: true },
    { showId: "bbq", show: "BBQ Radio Network", duration: 260 },
    { showId: "narration", show: "4a narration", duration: 28, narration: true },
    { showId: "bbq", show: "BBQ Radio Network", duration: 210 },
    { showId: "moreish", show: "The Moreish Podcast", duration: 330 },
  ];
}

function galleryContrastPairs(scheme) {
  var ratios = scheme === "dark"
    ? ["15.76", "14.06", "8.85", "5.38", "6.07", "7.10", "10.60", "6.49", "7.59", "8.56", "8.24", "5.47"]
    : ["15.26", "17.01", "6.56", "5.14", "4.99", "7.53", "13.40", "4.41", "6.65", "4.74", "4.79", "3.14"];
  var pairs = [
    { id: "ink-paper", label: "Ink on paper", ratio: ratios[0] },
    { id: "ink-card", label: "Ink on card", ratio: ratios[1] },
    { id: "ink-2-paper", label: "Secondary ink on paper", ratio: ratios[2] },
    { id: "ink-3-paper", label: "Tertiary ink on paper", ratio: ratios[3] },
    { id: "on-persimmon", label: "Key text on persimmon", ratio: ratios[4] },
    { id: "on-ultramarine", label: "Key text on ultramarine", ratio: ratios[5] },
    { id: "on-rubber", label: "Key text on rubber", ratio: ratios[6] },
    { id: "persimmon-paper", label: "Persimmon on paper · UI", ratio: ratios[7] },
    { id: "ultramarine-paper", label: "Ultramarine on paper", ratio: ratios[8] },
    { id: "good-paper", label: "Ready on paper", ratio: ratios[9] },
    { id: "warn-paper", label: "Warning on paper", ratio: ratios[10] },
    { id: "segment-enamels", label: "Station enamels on well · UI", ratio: ratios[11] },
  ];
  return pairs.map(function (pair) {
    var enamels = pair.id === "segment-enamels"
      ? '<span class="gallery-contrast__segments" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>'
      : "";
    return '<li class="gallery-contrast__pair gallery-contrast__pair--' + esc(pair.id) + '" data-pair="' + esc(pair.id) + '">' + enamels + '<span>' + esc(pair.label) + '</span><strong class="readout">' + esc(pair.id === "segment-enamels" ? "≥ " : "") + esc(pair.ratio) + ':1</strong></li>';
  }).join("");
}

function galleryTypeAndContrast(scheme, label) {
  var id = "gallery-" + scheme + "-type";
  return '<section class="gallery-scheme gallery-scheme--' + esc(scheme) + '" id="' + esc(id) + '" aria-labelledby="' + esc(id) + '-title"><div class="gallery-type"><p class="readout">' + esc(label) + '</p><h2 class="heading" id="' + esc(id) + '-title">Type and contrast</h2>' +
    '<p class="display-xl" data-type-role="display-xl">Today</p>' +
    '<p class="display" data-type-role="display">' + esc("Podcasts, lined up around you.") + '</p>' +
    '<p class="title" data-type-role="title">Barbecue: eight stories from a much longer history</p>' +
    '<p class="heading" data-type-role="heading">Also today</p>' +
    '<p class="gallery-body-lg" data-type-role="body-lg">A familiar craft opens onto how words change.</p>' +
    '<p data-type-role="body">Body text stays readable at the smallest listening size.</p>' +
    '<p class="gallery-label" data-type-role="label">Label · 13/16 · 700</p>' +
    '<p class="gallery-micro" data-type-role="micro">Micro · 12/16 · 600</p>' +
    '<p class="readout-lg" data-type-role="readout-lg">12:40</p>' +
    '<p class="readout" data-type-role="readout">about 22 min · 4 shows</p>' +
    '<ul class="gallery-contrast" aria-label="' + esc(label) + ' contrast table">' + galleryContrastPairs(scheme) + '</ul></div></section>';
}

function galleryControls(scheme) {
  var dark = scheme === "dark";
  return '<section class="gallery-block" id="gallery-' + esc(scheme) + '-controls" aria-labelledby="gallery-' + esc(scheme) + '-controls-title"><h3 class="heading" id="gallery-' + esc(scheme) + '-controls-title">Controls and states</h3>' +
    '<div class="gallery-state-grid">' +
    '<div><span class="gallery-label">Default</span>' + tactileKeycap({ variant: "persimmon", text: "Play", icon: "ph-play-fill", label: "Play" }) + '</div>' +
    '<div><span class="gallery-label">Pressed</span>' + tactileKeycap({ variant: "rubber", text: "Skip", icon: "skip-30", label: "Skip", pressed: true }) + '</div>' +
    '<div><span class="gallery-label">Focus</span>' + tactileKeycap({ variant: "ultramarine", text: "Make", icon: "ph-sparkle", label: "Make", focus: true }) + '</div>' +
    '<div><span class="gallery-label">Disabled</span>' + tactileKeycap({ variant: "paper", text: "Saved", icon: "ph-bookmark-simple", label: "Saved", disabled: true }) + '</div>' +
    '<div><span class="gallery-label">Loading</span>' + tactileKeycap({ variant: "paper", text: "Loading", label: "Loading", loading: true }) + '</div>' +
    '<div><span class="gallery-label">Offline</span>' + tactileKeycap({ variant: "paper", text: "Needs a connection", label: "Needs a connection", offline: true }) + '</div>' +
    '</div><div class="gallery-size-row">' +
    tactileKeycap({ size: "sm", variant: "paper", icon: "ph-bookmark-simple", label: "Small key" }) +
    tactileKeycap({ size: "md", variant: "paper", text: "Medium", label: "Medium key" }) +
    tactileKeycap({ size: "lg", variant: "persimmon", text: "Large", label: "Large key" }) +
    tactileKeycap({ size: "xl", variant: "persimmon", round: true, icon: "ph-play-fill", label: "Extra large play" }) +
    '</div><div class="gallery-state-row">' +
    tactileTextButton({ text: "Just show me" }) + tactileTextButton({ text: "Focused", focus: true }) + tactileTextButton({ text: "Unavailable", disabled: true }) +
    '</div><div class="gallery-state-row">' +
    tactileChip({ text: "Forays" }) + tactileChip({ text: "Shows", selected: true }) + tactileChip({ text: "Up Next", count: 4 }) + tactileChip({ text: "Focus", focus: true }) + tactileChip({ text: "Loading", loading: true }) + tactileChip({ text: "Disabled", disabled: true }) +
    '</div><div class="gallery-state-row">' +
    tactileTag({ kind: "stretch", text: "Stretch" }) + tactileTag({ kind: "narration", text: "4a narration" }) + tactileTag({ kind: "downloaded", text: "Downloaded" }) + tactileTag({ kind: "played", text: "Played" }) + tactileTag({ kind: "playing", text: "Playing" }) +
    '</div><div class="gallery-state-row gallery-art-row">' +
    tactileArtFrame({ size: "row", initials: "OS", title: "Origin Stories" }) + tactileArtFrame({ size: "queue", initials: "BR", title: "BBQ Radio Network" }) + tactileArtFrame({ size: "mini", initials: "MP", title: "The Moreish Podcast" }) + tactileArtFrame({ size: "disc", initials: "4a", title: "4a", round: true }) + tactileArtFrame({ size: "row", initials: "LO", title: "Loading artwork", loading: true }) + tactileArtFrame({ size: "row", initials: "OF", title: "Offline artwork", offline: true }) +
    '</div>' + (dark ? "" : '<p class="gallery-note">The 44px key is the floor; the larger keys are transport roles.</p>') + '</section>';
}

function gallerySurfaces(scheme) {
  var id = "gallery-" + scheme + "-surfaces";
  return '<section class="gallery-block" id="' + esc(id) + '" aria-labelledby="' + esc(id) + '-title"><h3 class="heading" id="' + esc(id) + '-title">Cards, wells, bands, and feedback</h3><div class="gallery-two">' +
    tactileCard({ eyebrow: "Card", title: "Raised enamel", copy: "One radius and one shadow carry grouped content." }) +
    tactileCard({ eyebrow: "Hero", title: "A bigger stage", copy: "The hero keeps the same material with more room.", hero: true }) +
    tactileWell({ text: "Inset well · 12:40" }) + tactileCard({ eyebrow: "Loading", title: "Stable geometry", copy: "The state keeps its final footprint.", loading: true }) +
    '</div><div class="gallery-band-stack" id="' + esc(id) + '-band-states"><span class="gallery-label">Line band · mini player</span>' + tactileBand({ id: id + "-line", kind: "line", segments: galleryBandSegments(), progress: .43, currentIndex: 2, renderWidth: 329 }) + '<span class="gallery-label">Mini band</span>' + tactileBand({ id: id + "-mini", kind: "mini", segments: galleryBandSegments(), progress: .43, currentIndex: 2, renderWidth: 329 }) + '<span class="gallery-label">Detail band · one code per run</span>' + tactileBand({ id: id + "-detail", kind: "detail", segments: galleryBandSegments(), progress: .43, currentIndex: 2, renderWidth: 329 }) + '<span class="gallery-label">Scrubber · slider</span>' + tactileBand({ id: id + "-scrub", kind: "scrub", segments: galleryBandSegments(), progress: .43, currentIndex: 2, totalSeconds: 1284, valueText: "9 minutes 12 of 21 minutes 24, BBQ Radio Network", renderWidth: 329 }) + '<span class="gallery-label">Buffering scrubber · pulsing needle</span>' + tactileBand({ id: id + "-buffering", kind: "scrub", segments: galleryBandSegments(), progress: .43, currentIndex: 2, totalSeconds: 1284, valueText: "Buffering at 9 minutes 12", renderWidth: 329, buffering: true }) + '</div>' +
    tactileGauge({}) + tactileBridgeCard({ sentence: "Machining shapes parts; language shapes meaning through the same steady pressure.", knownTitle: "Machining", knownInitials: "MA", title: "How words wear into new forms", show: "Lingthusiasm", duration: "35 min", initials: "LW" }) +
    '<div class="gallery-two">' + tactileToast({ text: "Removed from Up Next", action: "Undo" }) + tactileToast({ text: "Saved for later", action: "Undo", show: true }) + '</div><div class="gallery-two gallery-skeletons" id="' + esc(id) + '-skeletons">' + tactileSkeleton("row") + tactileSkeleton("hero") + tactileSkeleton("card") + '</div>' + tactileEmpty({ copy: "Nothing here yet. Follow a show and it lands here.", action: "Find a show" }) + '</section>';
}

function galleryRows(scheme) {
  var id = "gallery-" + scheme + "-rows";
  return '<section class="gallery-block" id="' + esc(id) + '" aria-labelledby="' + esc(id) + '-title"><h3 class="heading" id="' + esc(id) + '-title">Rows and tiles</h3><div class="gallery-rows">' +
    tactileShowRow({ name: "Origin Stories", meta: "12 episodes", initials: "OS", following: true }) +
    tactileEpisodeRow({ title: "A machine can teach a language", show: "Lingthusiasm - A podcast that's enthusiastic about linguistics", duration: "35 min", initials: "LI", why: "A familiar craft opens onto how words change.", downloaded: true }) +
    tactileEpisodeRow({ title: "A second episode waits nearby", show: "Design Matters | Debbie Millman", duration: "42 min", initials: "DM", queued: true }) +
    tactileEpisodeRow({ title: "Loading episode", show: "Show", duration: "35 min", initials: "LO", loading: true }) +
    tactileQueueRow({ position: 2, title: "The next station", show: "The Moreish Podcast", remaining: "28 min", initials: "MP" }) +
    tactileQueueRow({ current: true, title: "The station playing now", remaining: "18 min left", initials: "BR" }) +
    '</div><div class="gallery-tiles">' + tactileTile({ size: "s", name: "Language", count: "14 shows", initials: "LA" }) + tactileTile({ size: "s", name: "Machines", count: "9 shows", initials: "MA", focus: true }) + tactileTile({ size: "m", name: "Design and materials", count: "11 shows", initials: "DM" }) + tactileTile({ size: "l", name: "Ideas that cross the dial", count: "18 shows", initials: "ID" }) + '</div></section>';
}

function galleryNavigation(scheme) {
  var id = "gallery-" + scheme + "-navigation";
  return '<section class="gallery-block" id="' + esc(id) + '" aria-labelledby="' + esc(id) + '-title"><h3 class="heading" id="' + esc(id) + '-title">Deck, sheet, and rotary control</h3><div class="gallery-decks">' +
    /* Each deck sits in a .gallery-device frame (layout containment), so the
       specimen is the real fixed, inset, safe-area deck rather than a copy
       laid out in normal flow. First a foray (its colours in the mini's 3px
       line), then a single episode (one persimmon line), then collapsed. */
    '<div class="gallery-device">' + tactileTabBar({ active: "today", count: 4, mini: { title: "A machine can teach a language", show: "Lingthusiasm", initials: "LI", segments: galleryBandSegments(), progress: .43 } }) + "</div>" +
    '<div id="' + esc(id) + '-playing-mini"><div class="gallery-device">' + tactileTabBar({ active: "find", mini: { title: "Why bridges sing in the wind", show: "Origin Stories", initials: "OS", playing: true, progress: .6 } }) + "</div></div>" +
    '<div class="gallery-device gallery-device--bare">' + tactileTabBar({ active: "yours", count: 4, collapsed: true }) + "</div>" +
    '</div>' + tactileRotary({ label: "Playback speed", value: "1.0×" }) + tactileSheet({ id: id + "-preview", closeId: id + "-preview-close", title: "Sheet", copy: "Focus enters the container and every gesture has a button.", primary: "Done", secondary: "Not now", preview: true }) + '</section>';
}

function galleryScheme(scheme, label) {
  return '<section class="gallery-scheme gallery-scheme--' + esc(scheme) + '" id="gallery-' + esc(scheme) + '" aria-labelledby="gallery-' + esc(scheme) + '-title"><header class="gallery-scheme__head"><p class="readout">' + esc(label) + '</p><h2 class="display" id="gallery-' + esc(scheme) + '-title">Every primitive, every state</h2></header>' + galleryControls(scheme) + gallerySurfaces(scheme) + galleryRows(scheme) + galleryNavigation(scheme) + '</section>';
}

function renderGallery() {
  setBodyClass("view-gallery");
  $("#view").innerHTML = `
    <main class="gallery" aria-labelledby="gallery-title">
      <header class="gallery-head">
        <p class="readout">Tactile foundation</p>
        <h1 class="display-xl" id="gallery-title">Controls built for a thumb</h1>
        <p class="gallery-copy">Cream enamel, Bakelite, radio bands, and keycaps share one measured system.</p>
      </header>
      ` + galleryTypeAndContrast("light", "Cream · primary") + galleryScheme("light", "Cream · primary") + galleryTypeAndContrast("dark", "Bakelite · optional") + galleryScheme("dark", "Bakelite · optional") + `
      <section aria-labelledby="gallery-bold-title">
        <h2 class="heading" id="gallery-bold-title">Phosphor Bold</h2>
        <ul class="gallery-icons" role="list">
          <li><svg class="i" aria-hidden="true"><use href="#ph-play"></use></svg><span>play</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-pause"></use></svg><span>pause</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-sun-horizon"></use></svg><span>today</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-magnifying-glass"></use></svg><span>find</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-bookmarks"></use></svg><span>yours</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-caret-down"></use></svg><span>collapse</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-arrow-left"></use></svg><span>back</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-dots-three"></use></svg><span>more</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-plus"></use></svg><span>add</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-check"></use></svg><span>check</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-check-circle"></use></svg><span>ready</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-cloud-slash"></use></svg><span>offline</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-bookmark-simple"></use></svg><span>save</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-list-plus"></use></svg><span>queue</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-timer"></use></svg><span>sleep</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-share-network"></use></svg><span>share</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-x"></use></svg><span>close</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-arrow-up"></use></svg><span>up</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-arrow-down"></use></svg><span>down</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-trash"></use></svg><span>remove</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-radio"></use></svg><span>radio</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-speaker-high"></use></svg><span>sound</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-moon"></use></svg><span>dark</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-sun"></use></svg><span>light</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-list-bullets"></use></svg><span>list</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-shuffle"></use></svg><span>shuffle</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-sparkle"></use></svg><span>make</span></li>
        </ul>
      </section>
      <section aria-labelledby="gallery-fill-title">
        <h2 class="heading" id="gallery-fill-title">Active fills</h2>
        <ul class="gallery-icons" role="list">
          <li><svg class="i" aria-hidden="true"><use href="#ph-play-fill"></use></svg><span>play</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-pause-fill"></use></svg><span>pause</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-sun-horizon-fill"></use></svg><span>today</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-magnifying-glass-fill"></use></svg><span>find</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-bookmarks-fill"></use></svg><span>yours</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-bookmark-simple-fill"></use></svg><span>saved</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#ph-check-circle-fill"></use></svg><span>ready</span></li>
        </ul>
      </section>
      <section aria-labelledby="gallery-custom-title">
        <h2 class="heading" id="gallery-custom-title">Tactile marks</h2>
        <ul class="gallery-icons gallery-icons--custom" role="list">
          <li><svg class="i" aria-hidden="true"><use href="#skip-15"></use></svg><span>back 15</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#skip-30"></use></svg><span>ahead 30</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#band"></use></svg><span>band</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#needle"></use></svg><span>needle</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#bridge"></use></svg><span>bridge</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#narration"></use></svg><span>narration</span></li>
          <li><svg class="i" aria-hidden="true"><use href="#knob"></use></svg><span>knob</span></li>
        </ul>
      </section>
      ` + tactileSheet({ id: "gallery-sheet", closeId: "gallery-sheet-close", title: "Tactile sheet", copy: "Focus starts on this sheet, remains here, and returns to its opener.", primary: "Apply", secondary: "Not now" }) + `
    </main>`;
  var open = document.createElement("button");
  open.type = "button";
  open.id = "gallery-sheet-open";
  open.className = "keycap keycap--md keycap--ultramarine gallery-sheet-open";
  open.setAttribute("aria-label", "Open sheet specimen");
  open.innerHTML = tactileIcon("ph-caret-down") + '<span class="keycap__label">Open sheet specimen</span>';
  var navigation = $("#gallery-light-navigation");
  if (navigation) navigation.insertBefore(open, navigation.querySelector(".sheet--preview"));
  tactileWireSheet(open, $("#gallery-sheet"));
  document.querySelectorAll(".band--scrub").forEach(function (scrubber) {
    tactileWireScrubber(scrubber, { segments: galleryBandSegments(), totalSeconds: 1284 });
  });
}
