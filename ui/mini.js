/* ui/mini.js — Dial mini-player presentation.
 *
 * Playback remains owned by player/client.js. This file only arranges the
 * player-owned nodes into the Tactile mini: one body button (art + copy) and
 * two sibling keycaps. No listener data is interpolated here.
 */

function dialMiniIcon(id) {
  return typeof tactileIcon === "function" ? tactileIcon(id) : "";
}

function dialDecorateMiniPlayer(parts) {
  if (!parts || !parts.root || !parts.bar || !parts.info) return;
  parts.root.classList.add("dial-mini");
  parts.root.setAttribute("role", "region");
  parts.bar.classList.add("mini");
  parts.info.classList.add("mini__body");
  parts.title.classList.add("mini__title");
  parts.show.classList.add("mini__show");
  parts.art.classList.add("mini__art");
  parts.art.setAttribute("width", "44");
  parts.art.setAttribute("height", "44");
  parts.art.setAttribute("decoding", "async");
  parts.info.insertBefore(parts.art, parts.info.firstChild);

  parts.playBtn.className = "fp-play keycap keycap--md keycap--persimmon keycap--round";
  parts.skipBtn.className = "fp-skip keycap keycap--sm keycap--paper";
  parts.skipBtn.setAttribute("aria-label", "Forward 30 seconds");
  parts.skipBtn.innerHTML = dialMiniIcon("skip-30");
}

function dialPaintMiniPlayer(parts, data) {
  if (!parts || !parts.root) return;
  var d = data || {};
  var label = "Now playing: " + (d.title || "") + (d.show ? ", " + d.show : "");
  parts.root.setAttribute("aria-label", label);
  parts.playBtn.innerHTML = dialMiniIcon(d.running ? "ph-pause-fill" : "ph-play-fill");
  parts.playBtn.setAttribute("aria-label", d.running ? "Pause" : "Play");
}

window.DialMiniPlayer = {
  decorate: dialDecorateMiniPlayer,
  paint: dialPaintMiniPlayer,
};
