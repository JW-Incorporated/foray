/* ui/gallery.js — Redesign component gallery (#/gallery).
 *
 * The route is development-only: a Lab build or an explicit ?gallery=1 query
 * may open it. Production navigation never links to it. Phase 3 task 2 starts
 * the gallery with the Tactile icon family; later foundation tasks add their
 * primitives here without putting review fixtures on listener screens.
 *
 * This is a classic script and shares app.js's globals. Nothing here runs until
 * renderCurrentPage() selects the guarded route.
 */

function galleryEnabled() {
  return isLabBuild() || new URLSearchParams(location.search).get("gallery") === "1";
}

function renderGallery() {
  setBodyClass("view-gallery");
  $("#view").innerHTML = `
    <main class="gallery" aria-labelledby="gallery-title">
      <header class="gallery-head">
        <p class="readout">Tactile foundation</p>
        <h1 class="display-xl" id="gallery-title">Icon family</h1>
        <p class="gallery-copy">Phosphor Bold, active fills, and seven marks share one optical size.</p>
      </header>
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
    </main>`;
}
