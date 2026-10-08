/* ui/interests.js — Tuning page (#/tuning, was #/interests): the slider rows and their bindings.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init().

   REDESIGN 2026, ambient (DIRECTION.md "Information architecture"): "Interests as sliders becomes three states
   per subject (less, 4a's pick, more) inside Tuning, nearer to 'observed'." A slider asks the listener for a
   number they do not have; three words ask for a direction. The route, the storage key and the weights are
   unchanged — `#/interests`, `cp_interests`, `state.interests[id]` in 0..1 — so every ranker that reads them
   (interestScore, buildCards, the playlist builder) is untouched; only the control changed.

   THE THREE STATES ARE POSITIONS RELATIVE TO 4a's OWN PICK, the taxonomy weight the subject starts at:

     less       0.4 x the pick                   (0.5 -> 0.2)
     4a's pick  the pick itself                  (0.5 -> 0.5; also what a play-learned nudge under 0.03 reads as)
     more       the pick + 0.3, capped at 1      (0.5 -> 0.8)

   A row's state is OBSERVED from the stored weight, never declared: a weight a listener's plays have moved
   reads as less or more, and tapping "4a's pick" puts it back exactly (the old "Back to 4a's pick" button is
   now the middle chip). A state whose weight would sit within 0.03 of the pick (a subject already at 1 has no
   "more") is disabled rather than shown as a choice that changes nothing. */

const TUNE_STATES = [["less", "Less"], ["pick", "4a's pick"], ["more", "More"]];
/** Two weights closer than this are the same state (and a choice that moves less than this is not offered). */
const TUNE_EPSILON = 0.03;

/** The weight 4a starts a subject at. */
function tuneDefault(node) {
  return Math.max(0, node.weight);
}

/** The weight a state stands for, rounded to two places so the stored profile stays readable. */
function tuneWeight(node, which) {
  const base = tuneDefault(node);
  if (which === "less") return Math.round(base * 0.4 * 100) / 100;
  if (which === "more") return Math.round(Math.min(1, base + 0.3) * 100) / 100;
  return base;
}

/** Which state the stored weight reads as. A subject with no stored weight is at 4a's pick. */
function tuneState(node) {
  const base = tuneDefault(node);
  const v = typeof state.interests[node.id] === "number" ? state.interests[node.id] : base;
  if (v <= base - TUNE_EPSILON) return "less";
  if (v >= base + TUNE_EPSILON) return "more";
  return "pick";
}

/** Whether a state is a real choice for this subject: its weight differs from 4a's pick. */
function tuneOffered(node, which) {
  return which === "pick" || Math.abs(tuneWeight(node, which) - tuneDefault(node)) >= TUNE_EPSILON;
}

function interestTuneRow(node) {
  const isRoot = node.parent === null;
  const current = tuneState(node);
  const nameId = "tune-name-" + node.id;
  const options = TUNE_STATES.map(([which, label]) => [which, label, !tuneOffered(node, which)]);
  return `<div class="st-tune-row${isRoot ? " st-tune-root" : ""}">`
    + `<p class="st-tune-name t-label" id="${esc(nameId)}">${esc(node.label)}</p>`
    + stSegHtml({ options, value: current, labelledBy: nameId, attrs: [["data-interest-id", node.id]] })
    + `</div>`;
}

function renderInterests() {
  setBodyClass("view-settings");
  const groups = interestGroups();
  $("#view").innerHTML = stPageHtml("tuning", "Tuning",
    `<p class="st-lede t-body">${esc("Choose less or more of a subject. 4a's pick is where it starts.")}</p>`
    + groups.map(interestGroupHtml).join(""));
  bindInterestsControls($("#view"));
}

/* ONE NAME PER BLOCK (audit round 2, visual-17). Every root is always a row of
   its own group, and a leaf joins only once the listener has moved it, so for
   a new listener EVERY group was a heading over one card with the same name —
   "Adventure" over "Adventure", the page twice as long as its content. The
   heading is only there to gather a root's sub-subjects; with none, the row
   names itself. */
function interestGroupHtml(g) {
  return `<section class="st-group">${g.rows.length > 1 ? `<h3 class="st-group-label t-headline">${esc(g.root.label)}</h3>` : ""}${g.rows.map(interestTuneRow).join("")}</section>`;
}

/** Apply one choice: the weight, saved through the shim, the rankers told. Returns the state now stored. */
function chooseInterest(id, which) {
  const node = nodeById(id);
  if (!node || !TUNE_STATES.some(s => s[0] === which) || !tuneOffered(node, which)) return null;
  setInterest(id, tuneWeight(node, which));
  saveInterests();
  state._interestsGen = (state._interestsGen || 0) + 1;
  return tuneState(node);
}

function bindInterestsControls(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-interest-id]").forEach(group => {
    if (group._bound) return;
    group._bound = true;
    const id = group.getAttribute("data-interest-id");
    group.addEventListener("click", (e) => {
      const chip = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-st-value]") : null;
      if (!chip || chip.disabled) return;
      const now = chooseInterest(id, chip.getAttribute("data-st-value"));
      if (now) stSegSelect(group, now);
    });
    group.addEventListener("keydown", stSegKey);
  });
}
