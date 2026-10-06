/* ui/interests.js — Interests page (#/interests): the slider rows and their bindings.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


function interestSliderRow(node) {
  const value = typeof state.interests[node.id] === "number" ? state.interests[node.id] : Math.max(0, node.weight);
  const pct = Math.round(value * 100);
  const isRoot = node.parent === null;
  return `<div class="interest-row${isRoot ? " interest-row-root" : ""}">
    <div class="interest-row-head">
      <span class="interest-row-name">${esc(node.label)}</span>
    </div>
    <div class="interest-row-controls">
      <input type="range" class="interest-slider" role="slider"
        min="0" max="1" step="0.01" value="${value}"
        data-interest-id="${esc(node.id)}"
        aria-label="${esc(node.label)} interest"
        aria-valuemin="0" aria-valuemax="1" aria-valuenow="${value}"
        aria-valuetext="${pct}%">
      <span class="interest-row-pct">${pct}%</span>
      <button type="button" class="interest-reset" data-interest-reset="${esc(node.id)}"${controlLabelAttr("Back to 4a's pick", `${node.label}: back to 4a's pick`)}
        ${value === Math.max(0, node.weight) ? "disabled" : ""}>Back to 4a's pick</button>
    </div>
  </div>`;
}

function renderInterests() {
  /* Was a direct `document.body.className = "view-page"`, the one render
     function that never got routed through setBodyClass when that helper was
     introduced — so the Interests page dropped `ui-v2` itself, not just the
     runtime classes, and rendered the whole page off the pre-cutover sheet. */
  setBodyClass("view-page");
  const groups = interestGroups();
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Interests</h2><p class="sub">Drag a slider to change what 4a suggests.</p></div>
      </div>
      ${groups.map(interestGroupHtml).join("")}
    </div>`;
  bindInterestsControls($("#view"));
}

/* ONE NAME PER BLOCK (audit round 2, visual-17). Every root is always a row of
   its own group, and a leaf joins only once the listener has moved it, so for
   a new listener EVERY group was a heading over one card with the same name —
   "Adventure" over "Adventure", the page twice as long as its content. The
   heading is only there to gather a root's sub-topics; with none, the card
   names itself. */
function interestGroupHtml(g) {
  return `
        <div class="interest-group">
          ${g.rows.length > 1 ? `<h3 class="interest-group-label">${esc(g.root.label)}</h3>` : ""}
          ${g.rows.map(interestSliderRow).join("")}
        </div>`;
}

function bindInterestsControls(scope) {
  scope.querySelectorAll("[data-interest-id]").forEach(input => {
    if (input._bound) return;
    input._bound = true;
    const id = input.dataset.interestId;
    const apply = () => {
      const v = Math.max(0, Math.min(1, Number(input.value)));
      setInterest(id, v);
      saveInterests();
      state._interestsGen = (state._interestsGen || 0) + 1;
      input.setAttribute("aria-valuenow", String(v));
      input.setAttribute("aria-valuetext", `${Math.round(v * 100)}%`);
      const row = input.closest(".interest-row");
      const pct = row?.querySelector(".interest-row-pct");
      if (pct) pct.textContent = `${Math.round(v * 100)}%`;
      const resetBtn = row?.querySelector("[data-interest-reset]");
      const node = nodeById(id);
      if (resetBtn && node) resetBtn.disabled = v === Math.max(0, node.weight);
    };
    input.addEventListener("input", apply);
    input.addEventListener("change", apply);
  });
  scope.querySelectorAll("[data-interest-reset]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", () => {
      const id = btn.dataset.interestReset;
      const node = nodeById(id);
      if (!node) return;
      setInterest(id, Math.max(0, node.weight));
      saveInterests();
      state._interestsGen = (state._interestsGen || 0) + 1;
      renderInterests();
    });
  });
}
