const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = __dirname;
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

function makeEl(tag) {
  return { tagName: String(tag||"div").toUpperCase(), id:null, className:"", innerHTML:"", textContent:"", value:"",
    hidden:false, disabled:false, dataset:{}, style:{}, children:[],
    classList:{add(){},remove(){},toggle(){},contains:()=>false},
    addEventListener(){}, removeEventListener(){},
    appendChild(k){this.children.push(k);return k;}, append(...k){this.children.push(...k);},
    setAttribute(){}, getAttribute:()=>null, removeAttribute(){},
    querySelector:()=>null, querySelectorAll:()=>[],
    closest:()=>null, focus(){}, select(){}, click(){}, remove(){} };
}
const PAGE_IDS = ["view","drawer","drawer-overlay","drawer-playlists","family-toggle","player-toggle",
  "autoadvance-toggle","menu-btn","refresh-btn","banner-slot","pl-form","pl-input","pl-note",
  "tab-topics","tab-shows","sh-form","sh-input","sh-note","sh-results","browse-all-link"];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k,v])=>[k,String(v)]));
  const byId = new Map(PAGE_IDS.map(id=>{const el=makeEl("div"); el.id=id; return [id,el];}));
  const body = makeEl("body");
  const eventLog = { rows: [], append(r){this.rows.push(r);}, async unsynced(){return this.rows;},
    async markSynced(){}, async pruneToRetention(){}, health(){return {ok:true,backend:"memory",pending:0,ringSize:this.rows.length,faults:[]};} };
  const ctx = {
    console: {...console, warn(){}, error(){}},
    fetch: (url) => {
      if (!boot) return new Promise(()=>{});
      const file = path.join(ROOT, String(url));
      const ok = String(url).startsWith("data/") && fs.existsSync(file);
      return Promise.resolve({ ok, status: ok?200:404, json: async ()=>JSON.parse(fs.readFileSync(file,"utf8")) });
    },
    localStorage: { get length(){return store.size;}, key:(i)=>[...store.keys()][i]??null,
      getItem:(k)=>store.has(k)?store.get(k):null, setItem:(k,v)=>{store.set(k,String(v));}, removeItem:(k)=>{store.delete(k);} },
    forayEventLog: eventLog,
    document: { body, documentElement: body, readyState:"complete", addEventListener(){}, createElement:(t)=>makeEl(t),
      querySelector: (sel) => { const s=String(sel); return s.startsWith("#") ? byId.get(s.slice(1))??null : null; },
      querySelectorAll: ()=>[] },
    navigator: {userAgent:"node"}, addEventListener(){}, removeEventListener(){},
    location: {hash:"#/", search:"", pathname:"/", href:"https://x.test/"},
    history: {replaceState(){}, pushState(){}}, CSS: {escape:(s)=>String(s)},
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn,ms)=>{const t=setTimeout(fn,ms); if(t&&t.unref) t.unref(); return t;},
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, {filename:"search-engine.js"});
  vm.runInContext(APP_SRC, ctx, {filename:"app.js"});
  const evalIn = (src) => vm.runInContext(src, ctx);
  return { ctx, evalIn, store, state: evalIn("state"), view: ()=>byId.get("view").innerHTML,
    playlistsRaw: ()=>JSON.parse(store.get("cp_playlists")) };
}
async function mountBooted(seed) {
  const m = mount({seed, boot:true});
  for (let i=0;i<200 && !m.state.ready; i++) await new Promise(r=>setTimeout(r,0));
  assert.ok(m.state.ready, "init() never finished");
  return m;
}

(async () => {
  const m = await mountBooted();
  const built = m.ctx.buildPlaylist("physics");
  console.log("build status", built.status, "items", built.playlist?.items?.length);
  const saved = built.playlist;

  // AGE OUT ALL ITEMS AT ONCE (adversarial: 100% loss, not partial)
  const allIds = new Set(saved.items.map(p => p.id));
  m.state.discover.items = m.state.discover.items.filter(it => !allIds.has(it.id));
  for (const id of allIds) delete m.state.session.episodes[id];
  m.state.itemIndex = {};
  m.state.poolIds = new Set();

  let crashed = false, err = null;
  try {
    m.ctx.renderPlaylistDetail(saved.id);
  } catch (e) { crashed = true; err = e; }
  console.log("crashed on 100% age-out?", crashed, err && err.message);
  const html = m.view();
  console.log("archived rows:", (html.match(/class="ep-row gone"/g)||[]).length);
  console.log("has note about catalogue:", html.includes("not in 4a's catalogue right now"));
  console.log("row count total:", (html.match(/class="ep-row/g)||[]).length, "expected", saved.items.length);

  // Now test with a corrupted part: no title, no id (fully broken row)
  const m2 = await mountBooted();
  const built2 = m2.ctx.buildPlaylist("physics");
  const saved2 = built2.playlist;
  const corrupted = [...saved2.items];
  corrupted[0] = { id: null };   // no id at all -- fully unnamed/unresolvable
  m2.ctx.savePlaylists([{...saved2, items: corrupted}, ...m2.ctx.playlists().filter(p=>p.id!==saved2.id)]);
  let crashed2=false, err2=null;
  try { m2.ctx.renderPlaylistDetail(saved2.id); } catch(e) { crashed2=true; err2=e; }
  console.log("\ncrashed on null-id part?", crashed2, err2 && err2.stack);
  const html2 = m2.view();
  console.log("row count with 1 null-id part:", (html2.match(/class="ep-row/g)||[]).length, "expected", corrupted.length);
  console.log("has 'no longer in the catalogue' unnamed text:", html2.includes("Part no longer in the catalogue"));
})();
