/* Fixture behaviour for gates-fixture.html. Each line below is one deliberate violation. */
console.error("gx: deliberate console error");                         // gate: errors
setTimeout(() => { throw new Error("gx: deliberate uncaught error"); }, 50); // gate: errors (pageerror)
fetch("gx-missing.json").catch(() => {});                                // gate: requests (same-origin 404)
const sheet = document.getElementById("gx-sheet");
const open = () => { sheet.hidden = false; };                            // focus is NOT moved in: gate sheet-focus
document.getElementById("gx-open").addEventListener("click", open);
document.getElementById("gx-close").addEventListener("click", () => { sheet.hidden = true; }); // focus is NOT returned
if (location.hash === "#/sheet") open();
