import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Play, Pause, Search, Home, Library, Sparkles, Mic, ChevronLeft,
  ChevronRight, ChevronDown, RotateCcw, RotateCw, SkipBack, SkipForward,
  Check, Loader2, Mail, Apple, Shield, Zap, Layers, Plus, Radio, Clock, X,
  Share2, Send, ThumbsUp, ThumbsDown
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Design tokens                                                      */
/* ------------------------------------------------------------------ */
const T = {
  bg: "#151119",
  surface: "#1F1A26",
  surface2: "#2A2333",
  line: "#332B3E",
  text: "#F4F0E8",
  muted: "#9C93A8",
  faint: "#6E6579",
  amber: "#F2A33C",
  amberDim: "#F2A33C33",
  violet: "#A78BFA",
  violetDim: "#A78BFA26",
  good: "#4ADE80",
};

const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_BODY = "'DM Sans', -apple-system, sans-serif";

/* ------------------------------------------------------------------ */
/*  Sample data                                                        */
/* ------------------------------------------------------------------ */
const PODCASTS = {
  pm: { id: "pm", name: "Planet Money", by: "NPR", color: "#2A9D8F", initials: "PM",
    desc: "The economy explained. Imagine you could call up a friend and say, \"Meet me at the bar and tell me what's going on with the economy.\" That's this show.",
    followers: "2.1M" },
  ol: { id: "ol", name: "Odd Lots", by: "Bloomberg", color: "#E76F51", initials: "OL",
    desc: "Joe Weisenthal and Tracy Alloway explore the most interesting topics in finance, markets and economics.",
    followers: "890K" },
  rl: { id: "rl", name: "Radiolab", by: "WNYC Studios", color: "#8E6FD8", initials: "RL",
    desc: "Investigating a strange world. Radiolab is on a curiosity bender — science, legal history, and the edges of what we know.",
    followers: "1.8M" },
  tj: { id: "tj", name: "The Journal", by: "WSJ", color: "#4C8DF5", initials: "TJ",
    desc: "The most important stories about money, business and power, explained. Every weekday afternoon.",
    followers: "1.2M" },
  aq: { id: "aq", name: "Acquired", by: "Ben & David", color: "#D9A441", initials: "AQ",
    desc: "Every company has a story. Acquired tells the stories and strategies of great companies, in depth.",
    followers: "760K" },
  hf: { id: "hf", name: "Hard Fork", by: "NYT", color: "#5FB4C9", initials: "HF",
    desc: "A show about the future that's already here. Tech news made make-sense-able, weekly.",
    followers: "640K" },
  hb: { id: "hb", name: "Hidden Brain", by: "Hidden Brain Media", color: "#C46BAE", initials: "HB",
    desc: "Why do we do what we do? Shankar Vedantam uses science and storytelling to reveal the unconscious patterns that drive human behavior.",
    followers: "1.5M" },
  sysk: { id: "sysk", name: "Stuff You Should Know", by: "iHeart", color: "#7BA05B", initials: "SY",
    desc: "If you've ever wanted to know about anything — champagne, satanism, the Stonewall Uprising — you're in the right place.",
    followers: "2.4M" },
};

const EPISODES = [
  { id: "e1", pid: "ol", title: "Why the Repo Market Is Acting Weird Again", date: "Aug 8", dur: 3120,
    desc: "A deep look at the plumbing of the financial system — and why the pipes are rattling. Guests from the New York Fed walk through what repo stress signals actually mean, and what it would take for the Fed to step back in.",
    reason: "Because you finish every Odd Lots" },
  { id: "e2", pid: "aq", title: "Rocket Lab: The Other Space Company", date: "Aug 3", dur: 8400,
    desc: "The complete history and strategy of Rocket Lab — from a New Zealand garage to Neutron. How a company built a launch business the hard way, and what vertical integration really buys you.",
    reason: "New from a show you follow" },
  { id: "e3", pid: "hf", title: "The AI Voice Actors Strike Back", date: "Aug 7", dur: 3300,
    desc: "Synthetic voices are everywhere now. We talk to the performers, the startups, and the lawyers about who owns a voice.",
    reason: "Trending in Technology" },
  { id: "e4", pid: "hb", title: "The Cost of Convenience", date: "Aug 5", dur: 2940,
    desc: "Every shortcut has a hidden price. What we lose when everything gets easier — and the case for a little deliberate friction.",
    reason: "Because you liked 'Deep Work, Shallow Life'" },
  { id: "e5", pid: "pm", title: "The Vending Machine Economy", date: "Aug 6", dur: 1680,
    desc: "A tiny business with shockingly good margins, and what it teaches us about passive income myths." },
  { id: "e6", pid: "rl", title: "Sleep: The Unfinished Symphony", date: "Jul 29", dur: 3540,
    desc: "What your brain is actually doing for eight hours a night. Spoiler: it's not resting." },
];

const FORAYS = [
  {
    id: "f1",
    title: "How rockets got cheap",
    subject: "Space & Launch Economics",
    curated: true,
    blurb: "From $10,000 a kilogram to $1,500 — four shows on the reusability revolution.",
    segments: [
      { kind: "narrator", dur: 40, blurb: "Your narrator sets the scene: why launch cost is the number that unlocks everything else in space." },
      { kind: "source", pid: "aq", epTitle: "Rocket Lab: The Other Space Company", date: "Aug 3", dur: 780,
        blurb: "Why small launch almost never works as a business — and how one company made it work anyway." },
      { kind: "narrator", dur: 30, blurb: "Bridge: from small rockets to the economics of reuse." },
      { kind: "source", pid: "pm", epTitle: "The $1,500 Kilogram", date: "Jul 21", dur: 660,
        blurb: "Planet Money runs the numbers on what reusability actually saves — and where the savings go." },
      { kind: "narrator", dur: 30, blurb: "Bridge: cheap launch changes what's worth putting in orbit." },
      { kind: "source", pid: "hf", epTitle: "The Orbital Gold Rush", date: "Jun 30", dur: 720,
        blurb: "Constellations, space data centers, and the new customers cheap launch created." },
      { kind: "narrator", dur: 45, blurb: "Your narrator wraps up: three things to remember, and where to go deeper." },
    ],
  },
  {
    id: "f2",
    title: "The regional banking crisis, explained",
    subject: "Finance",
    curated: true,
    blurb: "What actually happened in March 2023 — told by the three shows that covered it best.",
    segments: [
      { kind: "narrator", dur: 35, blurb: "Your narrator sets the scene: how a bank built for startups ended up at the center of a bank run." },
      { kind: "source", pid: "pm", epTitle: "Anatomy of a Bank Run", date: "Mar 2023", dur: 690,
        blurb: "The mechanics of the run itself — duration risk, uninsured deposits, and a very bad Thursday." },
      { kind: "narrator", dur: 30, blurb: "Bridge: from one bank's failure to the system-wide response." },
      { kind: "source", pid: "ol", epTitle: "What the Fed's Backstop Really Does", date: "Mar 2023", dur: 840,
        blurb: "Odd Lots on the BTFP, moral hazard, and whether the fix created the next problem." },
      { kind: "narrator", dur: 30, blurb: "Bridge: the human side — inside the boardrooms that weekend." },
      { kind: "source", pid: "tj", epTitle: "48 Hours to Save the Banks", date: "Mar 2023", dur: 540,
        blurb: "The Journal reconstructs the emergency weekend, hour by hour." },
      { kind: "narrator", dur: 40, blurb: "Your narrator closes: what changed, what didn't, and the signals to watch." },
    ],
  },
  {
    id: "f3",
    title: "Why we sleep (and why we don't)",
    subject: "Health & Science",
    curated: true,
    blurb: "Three shows on the science of sleep, stitched into one listen.",
    segments: [
      { kind: "narrator", dur: 35, blurb: "Your narrator opens: the one-third of your life you know the least about." },
      { kind: "source", pid: "rl", epTitle: "Sleep: The Unfinished Symphony", date: "Jul 29", dur: 720,
        blurb: "What the sleeping brain is actually doing — memory, repair, and strange housekeeping." },
      { kind: "narrator", dur: 30, blurb: "Bridge: from the science to the habits." },
      { kind: "source", pid: "sysk", epTitle: "How Sleep Debt Works", date: "Jul 12", dur: 660,
        blurb: "Can you catch up on weekends? The honest answer, minus the wellness fluff." },
      { kind: "narrator", dur: 30, blurb: "Bridge: why knowing all this still doesn't get us to bed." },
      { kind: "source", pid: "hb", epTitle: "The Revenge Bedtime Procrastinator", date: "Jun 18", dur: 600,
        blurb: "Hidden Brain on why we sabotage our own sleep — and the psychology of reclaiming the night." },
      { kind: "narrator", dur: 40, blurb: "Your narrator wraps up with three changes that survive contact with real life." },
    ],
  },
];

const TOPICS = [
  "Sports", "Finance & Investing", "True Crime", "News & Politics", "Comedy",
  "Technology", "Health & Fitness", "History", "Science", "Business",
  "Self-Improvement", "Music", "Pop Culture", "Space",
];

const FRIENDS = [
  { id: "wy", name: "Wyatt", color: "#4C8DF5" },
  { id: "dv", name: "David", color: "#2A9D8F" },
  { id: "my", name: "Maya", color: "#C46BAE" },
  { id: "sm", name: "Sam", color: "#D9A441" },
];

const BUILD_STEPS = [
  "Searching 2.4M episodes for your subject",
  "Choosing the strongest segments",
  "Clipping just the relevant parts",
  "Recording narrator bridges",
  "Stitching your Foray together",
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
const forayDur = (f) => f.segments.reduce((s, x) => s + x.dur, 0);
const mins = (sec) => `${Math.round(sec / 60)} min`;
const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};
const segAt = (f, pos) => {
  let acc = 0;
  for (let i = 0; i < f.segments.length; i++) {
    if (pos < acc + f.segments[i].dur) return { idx: i, into: pos - acc, start: acc };
    acc += f.segments[i].dur;
  }
  const last = f.segments.length - 1;
  return { idx: last, into: f.segments[last].dur, start: acc - f.segments[last].dur };
};
const segColor = (seg) => (seg.kind === "narrator" ? T.violet : PODCASTS[seg.pid].color);
const sourceCount = (f) => f.segments.filter((s) => s.kind === "source").length;

/* ------------------------------------------------------------------ */
/*  Small shared pieces                                                */
/* ------------------------------------------------------------------ */
function Cover({ pid, size = 48, radius = 12 }) {
  const p = PODCASTS[pid];
  return (
    <div style={{
      width: size, height: size, minWidth: size, borderRadius: radius,
      background: `linear-gradient(135deg, ${p.color}, ${p.color}99)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "#fff", fontFamily: FONT_DISPLAY, fontWeight: 700,
      fontSize: size * 0.34, letterSpacing: "-0.02em",
      boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
    }}>{p.initials}</div>
  );
}

function NarratorCover({ size = 48, radius = 12 }) {
  return (
    <div style={{
      width: size, height: size, minWidth: size, borderRadius: radius,
      background: `linear-gradient(135deg, ${T.violet}, #7C5CE0)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
    }}><Radio size={size * 0.44} color="#fff" strokeWidth={2} /></div>
  );
}

/* The signature element: the stitched segment strip */
function SegmentStrip({ foray, pos = null, height = 6, gap = 3 }) {
  const total = forayDur(foray);
  const cur = pos != null ? segAt(foray, pos) : null;
  return (
    <div style={{ display: "flex", gap, width: "100%" }}>
      {foray.segments.map((seg, i) => {
        const isCur = cur && i === cur.idx;
        const isPast = cur && i < cur.idx;
        const fill = isCur ? Math.min(1, cur.into / seg.dur) : 0;
        return (
          <div key={i} style={{
            flexGrow: seg.dur, flexBasis: 0, height, borderRadius: height / 2,
            background: segColor(seg),
            opacity: cur ? (isPast || isCur ? 1 : 0.28) : 0.9,
            position: "relative", overflow: "hidden",
            transition: "opacity 0.3s",
            boxShadow: isCur ? `0 0 8px ${segColor(seg)}88` : "none",
          }}>
            {isCur && (
              <div style={{
                position: "absolute", top: 0, left: 0, bottom: 0,
                width: `${fill * 100}%`, background: "rgba(255,255,255,0.55)",
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Pill({ children, active, onClick, style = {} }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600,
      fontFamily: FONT_BODY, cursor: "pointer", border: "1px solid",
      borderColor: active ? T.amber : T.line,
      background: active ? T.amberDim : "transparent",
      color: active ? T.amber : T.muted,
      transition: "all 0.15s", ...style,
    }}>{children}</button>
  );
}

function SectionTitle({ children, action, onAction }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "26px 20px 12px" }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 600, color: T.text }}>{children}</div>
      {action && <button onClick={onAction} style={{ background: "none", border: "none", color: T.amber, fontSize: 12.5, fontWeight: 600, fontFamily: FONT_BODY, cursor: "pointer" }}>{action}</button>}
    </div>
  );
}

function BigButton({ children, onClick, disabled, style = {} }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", padding: "16px", borderRadius: 16, border: "none",
      background: disabled ? T.surface2 : T.amber,
      color: disabled ? T.faint : "#241A08",
      fontSize: 16, fontWeight: 700, fontFamily: FONT_BODY, cursor: disabled ? "default" : "pointer",
      transition: "all 0.2s", ...style,
    }}>{children}</button>
  );
}

/* ------------------------------------------------------------------ */
/*  Screens                                                            */
/* ------------------------------------------------------------------ */

function StatusBar() {
  return (
    <div style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 22px", fontSize: 13, fontWeight: 600, color: T.text, fontFamily: FONT_BODY, flexShrink: 0 }}>
      <span>9:41</span>
      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
        <div style={{ width: 16, height: 10, display: "flex", alignItems: "flex-end", gap: 1.5 }}>
          {[4, 6, 8, 10].map((h) => <div key={h} style={{ width: 2.5, height: h, background: T.text, borderRadius: 1 }} />)}
        </div>
        <div style={{ width: 22, height: 11, border: `1px solid ${T.text}99`, borderRadius: 3, padding: 1.5 }}>
          <div style={{ width: "70%", height: "100%", background: T.text, borderRadius: 1 }} />
        </div>
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 28px 40px" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{
          width: 84, height: 84, borderRadius: 26,
          background: `radial-gradient(circle at 30% 25%, ${T.amber}, #C97B18)`,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 8px 40px ${T.amber}44`, marginBottom: 24,
        }}>
          <Layers size={40} color="#241A08" strokeWidth={2.2} />
        </div>
        <div style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 600, fontSize: 46, color: T.text, letterSpacing: "-0.02em" }}>foray</div>
        <div style={{ color: T.muted, fontSize: 15, marginTop: 8, fontFamily: FONT_BODY }}>Podcasts, stitched around you.</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {[
          { icon: <Apple size={19} />, label: "Continue with Apple", bg: T.text, fg: "#151119" },
          { icon: <span style={{ fontWeight: 800, fontSize: 17 }}>G</span>, label: "Continue with Google", bg: T.surface2, fg: T.text },
          { icon: <Mail size={18} />, label: "Continue with email", bg: "transparent", fg: T.muted, border: true },
        ].map((b) => (
          <button key={b.label} onClick={onLogin} style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            padding: "15px", borderRadius: 15, fontSize: 15.5, fontWeight: 600, fontFamily: FONT_BODY,
            background: b.bg, color: b.fg, cursor: "pointer",
            border: b.border ? `1px solid ${T.line}` : "none",
          }}>{b.icon}{b.label}</button>
        ))}
      </div>
      <div style={{ textAlign: "center", color: T.faint, fontSize: 11.5, marginTop: 20, fontFamily: FONT_BODY }}>
        By continuing you agree to our Terms & Privacy Policy
      </div>
    </div>
  );
}

function WelcomeScreen({ onNext }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 26px 36px", overflowY: "auto" }}>
      <div style={{ marginTop: 34 }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 600, fontSize: 21, color: T.amber }}>foray</div>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 33, fontWeight: 600, color: T.text, lineHeight: 1.18, margin: "16px 0 0", letterSpacing: "-0.01em" }}>
          A podcast app that listens to <em style={{ color: T.amber }}>you</em> first.
        </h1>
        <p style={{ color: T.muted, fontSize: 15, lineHeight: 1.55, marginTop: 14, fontFamily: FONT_BODY }}>
          Two things make Foray different:
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 22 }}>
        <div style={{ background: T.surface, borderRadius: 20, padding: 20, border: `1px solid ${T.line}` }}>
          <div style={{ width: 42, height: 42, borderRadius: 13, background: T.amberDim, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
            <Zap size={21} color={T.amber} />
          </div>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18.5, fontWeight: 600, color: T.text }}>Suggestions that actually learn</div>
          <div style={{ color: T.muted, fontSize: 13.5, lineHeight: 1.55, marginTop: 7, fontFamily: FONT_BODY }}>
            Episode picks tuned to your subjects <em>and</em> the voices you trust — sharper every time you listen.
          </div>
        </div>

        <div style={{ background: T.surface, borderRadius: 20, padding: 20, border: `1px solid ${T.line}` }}>
          <div style={{ width: 42, height: 42, borderRadius: 13, background: T.violetDim, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
            <Layers size={21} color={T.violet} />
          </div>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18.5, fontWeight: 600, color: T.text }}>Forays: one subject, many shows</div>
          <div style={{ color: T.muted, fontSize: 13.5, lineHeight: 1.55, marginTop: 7, fontFamily: FONT_BODY }}>
            We clip the best parts of several podcasts on a subject and stitch them into one seamless listen — with a narrator bridging the gaps.
          </div>
          <div style={{ marginTop: 14 }}>
            <SegmentStrip foray={FORAYS[0]} height={7} />
          </div>
        </div>
      </div>

      <div style={{ flex: 1 }} />
      <BigButton onClick={onNext} style={{ marginTop: 28 }}>Get started</BigButton>
    </div>
  );
}

function PrefsScreen({ onDone }) {
  const [connected, setConnected] = useState({});
  const [picked, setPicked] = useState({});
  const [typed, setTyped] = useState("");
  const anyInput = Object.values(connected).some(Boolean) || Object.values(picked).some(Boolean) || typed.trim().length > 0;

  const connectors = [
    { id: "apple", label: "Apple Podcasts", sub: "Import listening history" },
    { id: "spotify", label: "Spotify", sub: "Import listening history" },
    { id: "yt", label: "YouTube", sub: "Import subscriptions" },
    { id: "google", label: "Google", sub: "Interests from your account" },
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 20px" }}>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 27, fontWeight: 600, color: T.text, margin: "24px 0 6px", lineHeight: 1.2 }}>
          What are you into?
        </h1>
        <p style={{ color: T.muted, fontSize: 14, fontFamily: FONT_BODY, margin: 0, lineHeight: 1.5 }}>
          This is how we tune your suggestions and build your first Forays.
        </p>

        {/* Top half: automate it */}
        <div style={{ marginTop: 22 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: T.amber, fontFamily: FONT_BODY, textTransform: "uppercase" }}>
            Fastest — let us figure it out
          </div>
          <div style={{ color: T.muted, fontSize: 13, fontFamily: FONT_BODY, margin: "6px 0 12px", lineHeight: 1.5 }}>
            Connect an account and we'll learn your interests automatically.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {connectors.map((c) => {
              const on = connected[c.id];
              return (
                <button key={c.id} onClick={() => setConnected((s) => ({ ...s, [c.id]: !s[c.id] }))} style={{
                  textAlign: "left", padding: "13px 14px", borderRadius: 15, cursor: "pointer",
                  background: on ? T.amberDim : T.surface,
                  border: `1px solid ${on ? T.amber : T.line}`, transition: "all 0.15s",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: T.text, fontSize: 13.5, fontWeight: 700, fontFamily: FONT_BODY }}>{c.label}</span>
                    {on && <Check size={15} color={T.amber} strokeWidth={3} />}
                  </div>
                  <div style={{ color: on ? T.amber : T.faint, fontSize: 11, fontFamily: FONT_BODY, marginTop: 3 }}>
                    {on ? "Connected" : c.sub}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 11 }}>
            <Shield size={13} color={T.faint} />
            <span style={{ color: T.faint, fontSize: 11.5, fontFamily: FONT_BODY }}>
              Your data is never sold or shared. <span style={{ color: T.muted, textDecoration: "underline", cursor: "pointer" }}>Privacy Policy</span>
            </span>
          </div>
        </div>

        {/* Divider */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 16px" }}>
          <div style={{ flex: 1, height: 1, background: `${T.amber}44` }} />
          <span style={{ color: T.amber, fontSize: 14.5, fontFamily: FONT_BODY, fontWeight: 700 }}>or pick subjects</span>
          <div style={{ flex: 1, height: 1, background: `${T.amber}44` }} />
        </div>

        {/* Bottom half: topic chips */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
          {TOPICS.map((t) => (
            <Pill key={t} active={picked[t]} onClick={() => setPicked((s) => ({ ...s, [t]: !s[t] }))}>{t}</Pill>
          ))}
        </div>

        {/* Tucked-away manual entry */}
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 10, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 15, padding: "12px 14px" }}>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Or type a subject yourself…"
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: T.text, fontSize: 14, fontFamily: FONT_BODY }}
          />
          <Mic size={18} color={T.muted} style={{ cursor: "pointer" }} />
        </div>
      </div>

      <div style={{ padding: "12px 24px 30px", borderTop: `1px solid ${T.line}` }}>
        <BigButton onClick={onDone} disabled={!anyInput}>
          {anyInput ? "Continue" : "Pick at least one to continue"}
        </BigButton>
      </div>
    </div>
  );
}

/* ---------------------------- Cards ------------------------------- */

function ForayCard({ foray, onPlay, progress = null, wide = false }) {
  const total = forayDur(foray);
  return (
    <button onClick={onPlay} style={{
      textAlign: "left", background: T.surface, border: `1px solid ${T.line}`,
      borderRadius: 20, padding: 16, cursor: "pointer",
      width: wide ? 250 : "100%", minWidth: wide ? 250 : undefined, flexShrink: 0,
      display: "flex", flexDirection: "column", gap: 0,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{
          fontSize: 10.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
          color: T.violet, fontFamily: FONT_BODY, background: T.violetDim, padding: "4px 9px", borderRadius: 8,
        }}>Foray · {foray.subject}</span>
        <Play size={16} color={T.amber} fill={T.amber} />
      </div>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 17.5, fontWeight: 600, color: T.text, lineHeight: 1.25, margin: "11px 0 6px" }}>
        {foray.title}
      </div>
      <div style={{ color: T.muted, fontSize: 12.5, lineHeight: 1.5, fontFamily: FONT_BODY, marginBottom: 13, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {foray.blurb}
      </div>
      <div style={{ marginTop: "auto" }}>
        <SegmentStrip foray={foray} pos={progress} height={6} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
          <span style={{ color: T.faint, fontSize: 11.5, fontFamily: FONT_BODY }}>
            {sourceCount(foray)} shows · {mins(total)}
          </span>
          {progress != null && (
            <span style={{ color: T.amber, fontSize: 11.5, fontWeight: 600, fontFamily: FONT_BODY }}>
              {mins(total - progress)} left
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function EpisodeRow({ ep, onPlay, onShow, progress = null }) {
  const p = PODCASTS[ep.pid];
  return (
    <div style={{ display: "flex", gap: 13, alignItems: "center", padding: "10px 20px" }}>
      <button onClick={onShow} style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}>
        <Cover pid={ep.pid} size={54} radius={14} />
      </button>
      <button onClick={onPlay} style={{ flex: 1, textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", minWidth: 0 }}>
        <div style={{ color: T.text, fontSize: 14.5, fontWeight: 600, fontFamily: FONT_BODY, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {ep.title}
        </div>
        <div style={{ color: T.muted, fontSize: 12, fontFamily: FONT_BODY, marginTop: 3 }}>
          {p.name} · {ep.date} · {mins(ep.dur)}
        </div>
        {ep.reason && (
          <div style={{ color: T.amber, fontSize: 11, fontFamily: FONT_BODY, marginTop: 3, fontWeight: 600 }}>
            {ep.reason}
          </div>
        )}
        {progress != null && (
          <div style={{ height: 3, background: T.surface2, borderRadius: 2, marginTop: 7, overflow: "hidden" }}>
            <div style={{ width: `${(progress / ep.dur) * 100}%`, height: "100%", background: T.amber }} />
          </div>
        )}
      </button>
      <button onClick={onPlay} style={{
        width: 36, height: 36, minWidth: 36, borderRadius: 18, background: T.surface2, border: "none",
        display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
      }}>
        <Play size={15} color={T.text} fill={T.text} style={{ marginLeft: 2 }} />
      </button>
    </div>
  );
}

/* ---------------------------- Home -------------------------------- */

function HomeScreen({ ctx }) {
  const { playForay, playEpisode, openShow, setTab, resume } = ctx;
  return (
    <div style={{ flex: 1, overflowY: "auto", paddingBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px 0" }}>
        <div>
          <div style={{ color: T.muted, fontSize: 12.5, fontFamily: FONT_BODY }}>Good evening</div>
          <div style={{ fontFamily: FONT_DISPLAY, fontStyle: "italic", fontWeight: 600, fontSize: 24, color: T.text }}>foray</div>
        </div>
        <div style={{ width: 38, height: 38, borderRadius: 19, background: `linear-gradient(135deg, ${T.amber}, #C97B18)`, display: "flex", alignItems: "center", justifyContent: "center", color: "#241A08", fontWeight: 800, fontSize: 15, fontFamily: FONT_BODY }}>J</div>
      </div>

      {/* Continue listening */}
      <SectionTitle>Jump back in</SectionTitle>
      <div style={{ display: "flex", gap: 12, overflowX: "auto", padding: "0 20px 4px" }} className="hscroll">
        <ForayCard foray={FORAYS[0]} progress={resume.f1} wide onPlay={() => playForay(FORAYS[0], resume.f1)} />
        <div style={{ width: 250, minWidth: 250, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 20, padding: 16, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Cover pid="ol" size={52} radius={14} />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: T.text, fontSize: 14, fontWeight: 600, fontFamily: FONT_BODY, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{EPISODES[0].title}</div>
              <div style={{ color: T.muted, fontSize: 11.5, fontFamily: FONT_BODY, marginTop: 3 }}>Odd Lots</div>
            </div>
          </div>
          <div style={{ marginTop: "auto", paddingTop: 14 }}>
            <div style={{ height: 5, background: T.surface2, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: "62%", height: "100%", background: PODCASTS.ol.color }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9 }}>
              <span style={{ color: T.faint, fontSize: 11.5, fontFamily: FONT_BODY }}>20 min left</span>
              <button onClick={() => playEpisode(EPISODES[0], EPISODES[0].dur * 0.62)} style={{ display: "flex", alignItems: "center", gap: 5, background: T.surface2, border: "none", borderRadius: 14, padding: "6px 12px", cursor: "pointer" }}>
                <Play size={12} color={T.text} fill={T.text} />
                <span style={{ color: T.text, fontSize: 12, fontWeight: 700, fontFamily: FONT_BODY }}>Resume</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Shared with you */}
      <SectionTitle>Shared with you</SectionTitle>
      <div style={{ margin: "0 20px" }}>
        <button onClick={() => playForay(FORAYS[2])} style={{
          width: "100%", textAlign: "left", cursor: "pointer",
          background: T.surface, border: `1px solid ${T.line}`, borderRadius: 20, padding: 15,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <FriendAvatar f={FRIENDS[0]} size={34} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ color: T.text, fontSize: 13, fontWeight: 700, fontFamily: FONT_BODY }}>Wyatt sent you a Foray</div>
              <div style={{ color: T.muted, fontSize: 12, fontFamily: FONT_BODY, fontStyle: "italic", marginTop: 1 }}>"The Hidden Brain part is so us"</div>
            </div>
            <Play size={16} color={T.amber} fill={T.amber} />
          </div>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 600, color: T.text, margin: "12px 0 9px" }}>{FORAYS[2].title}</div>
          <SegmentStrip foray={FORAYS[2]} height={6} />
          <div style={{ color: T.faint, fontSize: 11.5, fontFamily: FONT_BODY, marginTop: 8 }}>
            {sourceCount(FORAYS[2])} shows · {mins(forayDur(FORAYS[2]))}
          </div>
        </button>
      </div>

      {/* Episodes for you */}
      <SectionTitle>Episodes for you</SectionTitle>
      <div style={{ margin: "0 0" }}>
        {EPISODES.slice(0, 4).map((ep) => (
          <EpisodeRow key={ep.id} ep={ep} onPlay={() => playEpisode(ep)} onShow={() => openShow(ep.pid)} />
        ))}
      </div>

      {/* Curated forays */}
      <SectionTitle>Forays for you</SectionTitle>
      <div style={{ color: T.muted, fontSize: 12.5, fontFamily: FONT_BODY, margin: "-6px 20px 12px" }}>
        One subject, many shows — stitched into a single listen.
      </div>
      <div style={{ display: "flex", gap: 12, overflowX: "auto", padding: "0 20px 4px" }} className="hscroll">
        {FORAYS.slice(1).map((f) => <ForayCard key={f.id} foray={f} wide onPlay={() => playForay(f)} />)}
      </div>

      {/* Create prompt */}
      <div style={{ margin: "24px 20px 8px" }}>
        <button onClick={() => setTab("create")} style={{
          width: "100%", textAlign: "left", cursor: "pointer",
          background: `linear-gradient(135deg, ${T.violetDim}, ${T.amberDim})`,
          border: `1px solid ${T.line}`, borderRadius: 20, padding: 18,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Sparkles size={18} color={T.amber} />
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 17, fontWeight: 600, color: T.text }}>Build your own Foray</span>
          </div>
          <div style={{ color: T.muted, fontSize: 13, fontFamily: FONT_BODY, marginTop: 7, lineHeight: 1.5 }}>
            Name any subject. We'll find the best segments across podcasts and stitch them for you.
          </div>
          <div style={{ marginTop: 12, background: T.bg, borderRadius: 13, padding: "11px 14px", color: T.faint, fontSize: 13.5, fontFamily: FONT_BODY, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            What do you want to understand today?
            <Mic size={15} color={T.faint} />
          </div>
        </button>
      </div>
    </div>
  );
}

/* ---------------------------- Search ------------------------------ */

function SearchScreen({ ctx }) {
  const { playEpisode, openShow, startCreate } = ctx;
  const [q, setQ] = useState("");
  const active = q.trim().length > 0;
  return (
    <div style={{ flex: 1, overflowY: "auto", paddingBottom: 20 }}>
      <div style={{ padding: "14px 20px 0" }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 600, color: T.text, marginBottom: 14 }}>Search</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 15, padding: "12px 15px" }}>
          <Search size={17} color={T.muted} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Shows, episodes, or any subject"
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: T.text, fontSize: 14.5, fontFamily: FONT_BODY }} />
          {active && <X size={16} color={T.muted} style={{ cursor: "pointer" }} onClick={() => setQ("")} />}
        </div>
      </div>

      {!active && (
        <>
          <SectionTitle>Browse subjects</SectionTitle>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9, padding: "0 20px" }}>
            {TOPICS.slice(0, 10).map((t) => <Pill key={t} onClick={() => setQ(t)}>{t}</Pill>)}
          </div>
          <SectionTitle>Popular shows</SectionTitle>
          <div style={{ display: "flex", gap: 14, overflowX: "auto", padding: "0 20px" }} className="hscroll">
            {Object.values(PODCASTS).slice(0, 6).map((p) => (
              <button key={p.id} onClick={() => openShow(p.id)} style={{ background: "none", border: "none", cursor: "pointer", textAlign: "center", padding: 0 }}>
                <Cover pid={p.id} size={78} radius={20} />
                <div style={{ color: T.muted, fontSize: 11.5, fontFamily: FONT_BODY, marginTop: 7, width: 78, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
              </button>
            ))}
          </div>
        </>
      )}

      {active && (
        <>
          {/* Create-a-foray suggestion */}
          <div style={{ margin: "18px 20px 4px" }}>
            <button onClick={() => startCreate(q)} style={{
              width: "100%", textAlign: "left", cursor: "pointer",
              background: T.violetDim, border: `1px solid ${T.violet}55`, borderRadius: 17, padding: 15,
              display: "flex", alignItems: "center", gap: 13,
            }}>
              <div style={{ width: 42, height: 42, borderRadius: 13, background: T.violet, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Sparkles size={19} color="#fff" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: T.text, fontSize: 14.5, fontWeight: 700, fontFamily: FONT_BODY }}>Create a Foray about "{q}"</div>
                <div style={{ color: T.muted, fontSize: 12, fontFamily: FONT_BODY, marginTop: 2 }}>The best segments from many shows, stitched into one</div>
              </div>
              <ChevronRight size={17} color={T.violet} style={{ marginLeft: "auto", flexShrink: 0 }} />
            </button>
          </div>

          <SectionTitle>Shows</SectionTitle>
          <div style={{ display: "flex", gap: 14, overflowX: "auto", padding: "0 20px" }} className="hscroll">
            {Object.values(PODCASTS).slice(0, 5).map((p) => (
              <button key={p.id} onClick={() => openShow(p.id)} style={{ background: "none", border: "none", cursor: "pointer", textAlign: "center", padding: 0 }}>
                <Cover pid={p.id} size={70} radius={18} />
                <div style={{ color: T.muted, fontSize: 11.5, fontFamily: FONT_BODY, marginTop: 6, width: 70, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
              </button>
            ))}
          </div>

          <SectionTitle>Episodes</SectionTitle>
          {EPISODES.map((ep) => (
            <EpisodeRow key={ep.id} ep={{ ...ep, reason: undefined }} onPlay={() => playEpisode(ep)} onShow={() => openShow(ep.pid)} />
          ))}
        </>
      )}
    </div>
  );
}

/* ---------------------------- Create ------------------------------ */

function CreateScreen({ ctx }) {
  const { createSubject, setCreateSubject, playForay } = ctx;
  const [len, setLen] = useState("standard");
  const [phase, setPhase] = useState("idle"); // idle | building | done
  const [step, setStep] = useState(0);
  const [built, setBuilt] = useState(null);

  useEffect(() => {
    if (phase !== "building") return;
    if (step >= BUILD_STEPS.length) {
      const subject = createSubject.trim() || "Your subject";
      const f = {
        id: "custom",
        title: subject.charAt(0).toUpperCase() + subject.slice(1),
        subject: "Your Foray",
        blurb: `The strongest segments we found on ${subject.toLowerCase()}, stitched with narrator bridges.`,
        segments: FORAYS[1].segments,
      };
      setBuilt(f);
      setPhase("done");
      return;
    }
    const t = setTimeout(() => setStep((s) => s + 1), 950);
    return () => clearTimeout(t);
  }, [phase, step, createSubject]);

  const begin = () => { setStep(0); setBuilt(null); setPhase("building"); };

  const lens = [
    { id: "quick", label: "Quick", sub: "~20 min" },
    { id: "standard", label: "Standard", sub: "~40 min" },
    { id: "deep", label: "Deep dive", sub: "~75 min" },
  ];

  if (phase === "building" || phase === "done") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 26px", overflowY: "auto" }}>
        <div style={{ marginTop: 30 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.violet, fontFamily: FONT_BODY }}>
            {phase === "done" ? "Ready" : "Building your Foray"}
          </div>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 25, fontWeight: 600, color: T.text, marginTop: 8, lineHeight: 1.25 }}>
            {(createSubject.trim() || "Your subject").charAt(0).toUpperCase() + (createSubject.trim() || "Your subject").slice(1)}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 15, marginTop: 28 }}>
          {BUILD_STEPS.map((s, i) => {
            const done = i < step || phase === "done";
            const cur = i === step && phase === "building";
            return (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 13, opacity: done || cur ? 1 : 0.32, transition: "opacity 0.4s" }}>
                <div style={{
                  width: 26, height: 26, borderRadius: 13, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  background: done ? T.good + "22" : cur ? T.violetDim : T.surface2,
                }}>
                  {done ? <Check size={14} color={T.good} strokeWidth={3} />
                    : cur ? <Loader2 size={14} color={T.violet} className="spin" />
                    : <div style={{ width: 6, height: 6, borderRadius: 3, background: T.faint }} />}
                </div>
                <span style={{ color: done || cur ? T.text : T.muted, fontSize: 14, fontFamily: FONT_BODY, fontWeight: cur ? 600 : 400 }}>{s}</span>
              </div>
            );
          })}
        </div>

        {phase === "done" && built && (
          <div className="fadeup" style={{ marginTop: 28, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 20, padding: 18 }}>
            <SegmentStrip foray={built} height={8} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 11, marginBottom: 16 }}>
              <span style={{ color: T.muted, fontSize: 12.5, fontFamily: FONT_BODY }}>{sourceCount(built)} shows · {mins(forayDur(built))} · narrator bridges</span>
            </div>
            <BigButton onClick={() => { playForay(built); setPhase("idle"); setCreateSubject(""); }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Play size={16} fill="#241A08" /> Play your Foray</span>
            </BigButton>
            <button onClick={() => setPhase("idle")} style={{ width: "100%", marginTop: 10, background: "none", border: "none", color: T.muted, fontSize: 13, fontWeight: 600, fontFamily: FONT_BODY, cursor: "pointer", padding: 8 }}>
              Build a different one
            </button>
          </div>
        )}
        <div style={{ height: 30 }} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 30px" }}>
      <div style={{ marginTop: 20 }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 600, color: T.text }}>Build a Foray</div>
        <p style={{ color: T.muted, fontSize: 13.5, fontFamily: FONT_BODY, lineHeight: 1.55, margin: "8px 0 0" }}>
          Name a subject. We'll clip the best segments from across podcasts and stitch them into one listen, with a narrator to guide you between shows.
        </p>
      </div>

      <div style={{ marginTop: 20, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 17, padding: "4px 15px", display: "flex", alignItems: "center", gap: 10 }}>
        <input
          value={createSubject}
          onChange={(e) => setCreateSubject(e.target.value)}
          placeholder="e.g. the semiconductor supply chain"
          style={{ flex: 1, background: "none", border: "none", outline: "none", color: T.text, fontSize: 15, fontFamily: FONT_BODY, padding: "14px 0" }}
        />
        <Mic size={19} color={T.amber} style={{ cursor: "pointer" }} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {["The history of the Fed", "Mechanical watches", "Small launch economics"].map((s) => (
          <Pill key={s} onClick={() => setCreateSubject(s)} style={{ fontSize: 12 }}>{s}</Pill>
        ))}
      </div>

      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: T.muted, fontFamily: FONT_BODY, marginBottom: 10 }}>Length</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9 }}>
          {lens.map((l) => (
            <button key={l.id} onClick={() => setLen(l.id)} style={{
              padding: "12px 8px", borderRadius: 14, cursor: "pointer", textAlign: "center",
              background: len === l.id ? T.amberDim : T.surface,
              border: `1px solid ${len === l.id ? T.amber : T.line}`,
            }}>
              <div style={{ color: len === l.id ? T.amber : T.text, fontSize: 13.5, fontWeight: 700, fontFamily: FONT_BODY }}>{l.label}</div>
              <div style={{ color: T.faint, fontSize: 11, fontFamily: FONT_BODY, marginTop: 2 }}>{l.sub}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 26 }}>
        <BigButton onClick={begin} disabled={!createSubject.trim()}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Sparkles size={16} /> Build my Foray</span>
        </BigButton>
      </div>
    </div>
  );
}

/* ---------------------------- Library ----------------------------- */

function LibraryScreen({ ctx }) {
  const { playForay, playEpisode, openShow, resume } = ctx;
  return (
    <div style={{ flex: 1, overflowY: "auto", paddingBottom: 20 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 600, color: T.text, padding: "14px 20px 0" }}>Library</div>

      <SectionTitle>Continue listening</SectionTitle>
      <div style={{ display: "flex", gap: 12, overflowX: "auto", padding: "0 20px 4px" }} className="hscroll">
        <ForayCard foray={FORAYS[0]} progress={resume.f1} wide onPlay={() => playForay(FORAYS[0], resume.f1)} />
        <ForayCard foray={FORAYS[2]} progress={320} wide onPlay={() => playForay(FORAYS[2], 320)} />
      </div>

      <SectionTitle>Saved Forays</SectionTitle>
      {FORAYS.map((f) => (
        <button key={f.id} onClick={() => playForay(f)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 13, padding: "11px 20px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
          <div style={{ width: 54, minWidth: 54 }}>
            <SegmentStrip foray={f} height={5} gap={2} />
            <div style={{ marginTop: 4 }}><SegmentStrip foray={f} height={5} gap={2} /></div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: T.text, fontSize: 14.5, fontWeight: 600, fontFamily: FONT_BODY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.title}</div>
            <div style={{ color: T.muted, fontSize: 12, fontFamily: FONT_BODY, marginTop: 2 }}>{sourceCount(f)} shows · {mins(forayDur(f))}</div>
          </div>
          <Play size={16} color={T.muted} />
        </button>
      ))}

      <SectionTitle>Following</SectionTitle>
      <div style={{ display: "flex", gap: 14, overflowX: "auto", padding: "0 20px" }} className="hscroll">
        {["ol", "aq", "pm", "hf", "rl"].map((pid) => (
          <button key={pid} onClick={() => openShow(pid)} style={{ background: "none", border: "none", cursor: "pointer", textAlign: "center", padding: 0 }}>
            <Cover pid={pid} size={70} radius={18} />
            <div style={{ color: T.muted, fontSize: 11.5, fontFamily: FONT_BODY, marginTop: 6, width: 70, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{PODCASTS[pid].name}</div>
          </button>
        ))}
      </div>

      <SectionTitle>History</SectionTitle>
      {EPISODES.slice(3, 6).map((ep) => (
        <EpisodeRow key={ep.id} ep={{ ...ep, reason: undefined }} onPlay={() => playEpisode(ep)} onShow={() => openShow(ep.pid)} />
      ))}
    </div>
  );
}

/* ---------------------------- Show profile ------------------------ */

function ShowScreen({ pid, onBack, onPlayEpisode }) {
  const p = PODCASTS[pid];
  const eps = EPISODES.filter((e) => e.pid === pid);
  const extra = [
    { id: "x1", pid, title: "From the archive: the episode that started it all", date: "May 2", dur: 2400 },
    { id: "x2", pid, title: "Listener questions, answered honestly", date: "Apr 18", dur: 2100 },
  ];
  const list = [...eps, ...extra];
  const [following, setFollowing] = useState(true);
  return (
    <div style={{ position: "absolute", inset: 0, background: T.bg, zIndex: 40, display: "flex", flexDirection: "column" }} className="fadeup">
      <div style={{ padding: "46px 16px 0" }}>
        <button onClick={onBack} style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 14, width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <ChevronLeft size={19} color={T.text} />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 30px" }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <Cover pid={pid} size={88} radius={22} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 23, fontWeight: 600, color: T.text, lineHeight: 1.2 }}>{p.name}</div>
            <div style={{ color: T.muted, fontSize: 13, fontFamily: FONT_BODY, marginTop: 4 }}>{p.by} · {p.followers} followers</div>
          </div>
        </div>
        <p style={{ color: T.muted, fontSize: 13.5, lineHeight: 1.6, fontFamily: FONT_BODY, margin: "14px 0 16px" }}>{p.desc}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => setFollowing(!following)} style={{
            padding: "10px 22px", borderRadius: 20, fontSize: 13.5, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer",
            background: following ? "transparent" : T.amber, color: following ? T.text : "#241A08",
            border: following ? `1px solid ${T.line}` : "none",
          }}>{following ? "Following ✓" : "Follow"}</button>
        </div>

        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 600, color: T.text, margin: "26px 0 6px" }}>Episodes</div>
        {list.map((ep) => (
          <button key={ep.id} onClick={() => onPlayEpisode(ep.desc ? ep : { ...ep, desc: p.desc })} style={{ width: "100%", display: "flex", gap: 12, alignItems: "center", padding: "12px 0", background: "none", border: "none", borderBottom: `1px solid ${T.line}`, cursor: "pointer", textAlign: "left" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: T.text, fontSize: 14, fontWeight: 600, fontFamily: FONT_BODY, lineHeight: 1.35 }}>{ep.title}</div>
              <div style={{ color: T.faint, fontSize: 12, fontFamily: FONT_BODY, marginTop: 3 }}>{ep.date} · {mins(ep.dur)}</div>
            </div>
            <div style={{ width: 34, height: 34, minWidth: 34, borderRadius: 17, background: T.surface2, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Play size={13} color={T.text} fill={T.text} style={{ marginLeft: 1.5 }} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------- Share sheet ------------------------ */

function FriendAvatar({ f, size = 52, selected }) {
  return (
    <div style={{
      width: size, height: size, minWidth: size, borderRadius: size / 2,
      background: `linear-gradient(135deg, ${f.color}, ${f.color}99)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "#fff", fontWeight: 800, fontSize: size * 0.38, fontFamily: FONT_BODY,
      border: selected ? `2.5px solid ${T.amber}` : "2.5px solid transparent",
      boxShadow: selected ? `0 0 12px ${T.amber}66` : "none",
      transition: "all 0.15s",
    }}>{f.name[0]}</div>
  );
}

function ShareSheet({ target, onClose }) {
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const isForay = target.type === "foray";
  const title = target.item.title;

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(8,5,12,0.62)", zIndex: 60, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="slideup" style={{
        background: T.surface, borderRadius: "26px 26px 0 0", padding: "14px 22px 34px",
        border: `1px solid ${T.line}`, borderBottom: "none",
      }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: T.line, margin: "0 auto 16px" }} />

        {sent ? (
          <div style={{ textAlign: "center", padding: "18px 0 10px" }} className="fadeup">
            <div style={{ width: 54, height: 54, borderRadius: 27, background: T.good + "22", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
              <Check size={26} color={T.good} strokeWidth={3} />
            </div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 600, color: T.text }}>Sent to {picked.name}</div>
            <div style={{ color: T.muted, fontSize: 13, fontFamily: FONT_BODY, marginTop: 6 }}>They'll see it in their "Shared with you" on Foray.</div>
            <button onClick={onClose} style={{ marginTop: 18, background: T.surface2, border: "none", borderRadius: 14, padding: "11px 26px", color: T.text, fontSize: 13.5, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer" }}>Done</button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: isForay ? T.violet : T.amber, fontFamily: FONT_BODY }}>
              Share {isForay ? "this Foray" : "this episode"}
            </div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 600, color: T.text, marginTop: 5, lineHeight: 1.3 }}>{title}</div>
            {isForay && <div style={{ margin: "12px 0 2px" }}><SegmentStrip foray={target.item} height={6} /></div>}

            <div style={{ fontSize: 12, fontWeight: 700, color: T.muted, fontFamily: FONT_BODY, margin: "18px 0 10px" }}>Send on Foray</div>
            <div style={{ display: "flex", gap: 16 }}>
              {FRIENDS.map((f) => (
                <button key={f.id} onClick={() => setPicked(picked?.id === f.id ? null : f)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "center" }}>
                  <FriendAvatar f={f} selected={picked?.id === f.id} />
                  <div style={{ color: picked?.id === f.id ? T.text : T.muted, fontSize: 11.5, fontFamily: FONT_BODY, marginTop: 6, fontWeight: 600 }}>{f.name}</div>
                </button>
              ))}
            </div>

            {picked && (
              <div className="fadeup" style={{ marginTop: 14, display: "flex", gap: 9 }}>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Why should ${picked.name} hear this?`}
                  style={{ flex: 1, background: T.bg, border: `1px solid ${T.line}`, borderRadius: 14, padding: "12px 14px", outline: "none", color: T.text, fontSize: 13.5, fontFamily: FONT_BODY }} />
                <button onClick={() => setSent(true)} style={{ background: T.amber, border: "none", borderRadius: 14, width: 46, minWidth: 46, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                  <Send size={17} color="#241A08" />
                </button>
              </div>
            )}

            <div style={{ height: 1, background: T.line, margin: "18px 0 6px" }} />
            {["Copy link", "More options…"].map((l) => (
              <button key={l} onClick={onClose} style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: "12px 2px", color: T.muted, fontSize: 14, fontWeight: 600, fontFamily: FONT_BODY, cursor: "pointer" }}>{l}</button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------- Feedback ---------------------------- */

const FB_CHIPS = [
  "Not into this topic", "Didn't like the voice", "Leans too far left",
  "Leans too far right", "Too surface-level", "Too in-the-weeds",
  "Bad audio quality", "Heard this already", "Just not this show",
];

function Thumbs({ vote, onUp, onDown }) {
  return (
    <div style={{ display: "inline-flex", gap: 8, marginLeft: "auto" }}>
      <button onClick={onUp} style={{
        width: 34, height: 34, minWidth: 34, borderRadius: 17, cursor: "pointer",
        background: vote === "up" ? T.amberDim : T.surface2,
        border: `1px solid ${vote === "up" ? T.amber : "transparent"}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <ThumbsUp size={14} color={vote === "up" ? T.amber : T.muted} fill={vote === "up" ? T.amber : "none"} />
      </button>
      <button onClick={onDown} style={{
        width: 34, height: 34, minWidth: 34, borderRadius: 17, cursor: "pointer",
        background: vote === "down" ? "#F8717122" : T.surface2,
        border: `1px solid ${vote === "down" ? "#F87171" : "transparent"}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <ThumbsDown size={14} color={vote === "down" ? "#F87171" : T.muted} fill={vote === "down" ? "#F87171" : "none"} />
      </button>
    </div>
  );
}

function FeedbackSheet({ label, onClose, onSubmit }) {
  const [picks, setPicks] = useState({});
  const [text, setText] = useState("");
  const any = Object.values(picks).some(Boolean) || text.trim();
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(8,5,12,0.62)", zIndex: 45, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="slideup" style={{
        background: T.surface, borderRadius: "26px 26px 0 0", padding: "14px 22px 30px",
        border: `1px solid ${T.line}`, borderBottom: "none",
      }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: T.line, margin: "0 auto 16px" }} />
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 600, color: T.text }}>What missed for you?</div>
        <div style={{ color: T.muted, fontSize: 12.5, fontFamily: FONT_BODY, marginTop: 5, lineHeight: 1.5 }}>
          About <span style={{ color: T.text, fontWeight: 600 }}>{label}</span> — the more specific, the faster your picks get good.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
          {FB_CHIPS.map((c) => (
            <Pill key={c} active={picks[c]} onClick={() => setPicks((s) => ({ ...s, [c]: !s[c] }))} style={{ fontSize: 12 }}>{c}</Pill>
          ))}
        </div>
        <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, background: T.bg, border: `1px solid ${T.line}`, borderRadius: 14, padding: "11px 14px" }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell us in your own words…"
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: T.text, fontSize: 13.5, fontFamily: FONT_BODY }} />
          <Mic size={17} color={T.muted} />
        </div>
        <BigButton onClick={onSubmit} disabled={!any} style={{ marginTop: 16, padding: "14px" }}>
          {any ? "Tune my picks" : "Pick at least one"}
        </BigButton>
      </div>
    </div>
  );
}

/* ---------------------------- Player ------------------------------ */

function Player({ now, playing, setPlaying, setPos, onClose, onOpenShow, onShare }) {
  const isForay = now.type === "foray";
  const foray = isForay ? now.item : null;
  const ep = !isForay ? now.item : null;
  const total = isForay ? forayDur(foray) : ep.dur;
  const cur = isForay ? segAt(foray, now.pos) : null;
  const curSeg = isForay ? foray.segments[cur.idx] : null;
  const listRef = useRef(null);

  /* peek at a non-playing segment; auto-return after 8s of no interaction */
  const [expanded, setExpanded] = useState(null);
  const peekTimer = useRef(null);
  const peek = (i) => {
    setExpanded(i);
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setExpanded(null), 8000);
  };
  const backToNow = () => { clearTimeout(peekTimer.current); setExpanded(null); };
  useEffect(() => () => clearTimeout(peekTimer.current), []);

  /* feedback state: key -> 'up' | 'down' */
  const [fb, setFb] = useState({});
  const [fbSheet, setFbSheet] = useState(null); // { key, label }
  const voteUp = (key) => setFb((s) => ({ ...s, [key]: s[key] === "up" ? undefined : "up" }));
  const voteDown = (key, label) => {
    if (fb[key] === "down") setFb((s) => ({ ...s, [key]: undefined }));
    else setFbSheet({ key, label });
  };

  useEffect(() => {
    if (!isForay || !listRef.current || expanded != null) return;
    const el = listRef.current.querySelector(`[data-seg="${cur.idx}"]`);
    if (el) listRef.current.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" });
  }, [isForay, cur ? cur.idx : -1, expanded]);

  const seek = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setPos(frac * total);
  };

  const jumpSeg = (dir) => {
    if (!isForay) return;
    let acc = 0;
    const starts = foray.segments.map((s) => { const st = acc; acc += s.dur; return st; });
    const target = cur.idx + dir;
    if (target >= 0 && target < starts.length) setPos(starts[target] + 0.1);
  };

  /* boundaries for tick marks */
  const ticks = [];
  const segStarts = [];
  if (isForay) {
    let acc = 0;
    foray.segments.forEach((s, i) => { segStarts.push(acc); acc += s.dur; if (i < foray.segments.length - 1) ticks.push(acc / total); });
  }

  return (
    <div style={{ position: "absolute", inset: 0, background: T.bg, zIndex: 30, display: "flex", flexDirection: "column" }} className="slideup">
      {/* Header */}
      <div style={{ padding: "46px 20px 10px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 14, width: 38, height: 38, minWidth: 38, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <ChevronDown size={19} color={T.text} />
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: isForay ? T.violet : T.amber, fontFamily: FONT_BODY }}>
            {isForay ? `Foray · ${foray.subject}` : "Now playing"}
          </div>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 600, color: T.text, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {isForay ? foray.title : ep.title}
          </div>
        </div>
        <button onClick={onShare} style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 14, width: 38, height: 38, minWidth: 38, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <Share2 size={17} color={T.text} />
        </button>
      </div>

      {/* Foray: segment strip pinned under the title */}
      {isForay && (
        <div style={{ padding: "6px 20px 12px", flexShrink: 0 }}>
          <SegmentStrip foray={foray} pos={now.pos} height={8} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7 }}>
            <span style={{ color: T.faint, fontSize: 11, fontFamily: FONT_BODY }}>
              Part {cur.idx + 1} of {foray.segments.length}
            </span>
            <span style={{ color: T.faint, fontSize: 11, fontFamily: FONT_BODY }}>
              {sourceCount(foray)} shows · {mins(total)}
            </span>
          </div>
        </div>
      )}

      {/* Center: the part that changes */}
      {isForay ? (
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "4px 20px 16px", minHeight: 0, position: "relative" }}>
          {foray.segments.map((seg, i) => {
            const isCur = i === cur.idx;
            const isOpen = expanded != null ? i === expanded : isCur;
            const isPeek = isOpen && !isCur;
            const narr = seg.kind === "narrator";
            const p = narr ? null : PODCASTS[seg.pid];
            const key = `${foray.id}-seg${i}`;
            const label = narr ? "the Foray narrator" : p.name;
            return (
              <div key={i} data-seg={i}
                onClick={() => { if (!isOpen) { if (isCur) backToNow(); else peek(i); } }}
                style={{
                  borderRadius: 18, marginBottom: 10, transition: "all 0.35s",
                  background: isOpen ? T.surface : "transparent",
                  border: `1px solid ${isOpen ? segColor(seg) + (isCur ? "66" : "44") : "transparent"}`,
                  boxShadow: isCur && isOpen ? `0 4px 24px ${segColor(seg)}22` : "none",
                  opacity: isOpen ? 1 : isCur ? 0.9 : 0.55,
                  padding: isOpen ? 16 : "10px 12px",
                  cursor: isOpen ? "default" : "pointer",
                }}>
                <div style={{ display: "flex", gap: 12, alignItems: isOpen ? "flex-start" : "center" }}>
                  {narr ? <NarratorCover size={isOpen ? 52 : 38} radius={isOpen ? 14 : 11} /> : <Cover pid={seg.pid} size={isOpen ? 52 : 38} radius={isOpen ? 14 : 11} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ color: narr ? T.violet : p.color, fontSize: 11, fontWeight: 700, fontFamily: FONT_BODY, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                        {narr ? "Foray narrator" : p.name}
                      </span>
                      {isCur && playing && (
                        <span className="eq" style={{ display: "inline-flex", gap: 2, alignItems: "flex-end", height: 10 }}>
                          <i /><i /><i />
                        </span>
                      )}
                      {isPeek && (
                        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.faint, fontFamily: FONT_BODY, background: T.surface2, padding: "2.5px 7px", borderRadius: 7 }}>
                          {i < cur.idx ? "Earlier" : "Up ahead"}
                        </span>
                      )}
                    </div>
                    <div style={{ color: T.text, fontSize: isOpen ? 14.5 : 13, fontWeight: 600, fontFamily: FONT_BODY, lineHeight: 1.35, marginTop: 3 }}>
                      {narr ? (isOpen ? seg.blurb : "Narrator bridge") : seg.epTitle}
                    </div>
                    {isOpen && !narr && (
                      <>
                        <div style={{ color: T.muted, fontSize: 12, fontFamily: FONT_BODY, marginTop: 3 }}>
                          {seg.epTitle && `Original episode · ${seg.date}`} · clip {fmt(seg.dur)}
                        </div>
                        <div style={{ color: T.muted, fontSize: 12.5, lineHeight: 1.55, fontFamily: FONT_BODY, marginTop: 8 }}>{seg.blurb}</div>
                      </>
                    )}
                    {isOpen && narr && (
                      <div style={{ color: T.faint, fontSize: 11.5, fontFamily: FONT_BODY, marginTop: 6, fontStyle: "italic" }}>
                        AI-narrated bridge · {fmt(seg.dur)}
                      </div>
                    )}
                    {isOpen && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                        {!narr && (
                          <button onClick={(e) => { e.stopPropagation(); if (isPeek) peek(i); onOpenShow(seg.pid); }} style={{
                            display: "inline-flex", alignItems: "center", gap: 6,
                            background: T.surface2, border: "none", borderRadius: 13, padding: "8px 13px", cursor: "pointer",
                          }}>
                            <span style={{ color: T.text, fontSize: 12, fontWeight: 700, fontFamily: FONT_BODY }}>About {p.name}</span>
                            <ChevronRight size={13} color={T.muted} />
                          </button>
                        )}
                        {isPeek && (
                          <button onClick={(e) => { e.stopPropagation(); setPos(segStarts[i] + 0.1); backToNow(); }} style={{
                            display: "inline-flex", alignItems: "center", gap: 6,
                            background: segColor(seg) + "26", border: `1px solid ${segColor(seg)}55`, borderRadius: 13, padding: "8px 13px", cursor: "pointer",
                          }}>
                            <Play size={11} color={segColor(seg)} fill={segColor(seg)} />
                            <span style={{ color: segColor(seg), fontSize: 12, fontWeight: 700, fontFamily: FONT_BODY }}>Play this part</span>
                          </button>
                        )}
                        <div onClick={(e) => e.stopPropagation()} style={{ marginLeft: "auto", display: "flex" }}>
                          <Thumbs vote={fb[key]}
                            onUp={() => { voteUp(key); if (isPeek) peek(i); }}
                            onDown={() => { voteDown(key, label); if (isPeek) peek(i); }} />
                        </div>
                      </div>
                    )}
                    {!isOpen && (
                      <div style={{ color: T.faint, fontSize: 11, fontFamily: FONT_BODY, marginTop: 2 }}>{fmt(seg.dur)}</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <div style={{ height: 60 }} />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 24px 16px", minHeight: 0 }}>
          <div style={{ display: "flex", justifyContent: "center", margin: "14px 0 22px" }}>
            <Cover pid={ep.pid} size={210} radius={34} />
          </div>
          <button onClick={() => onOpenShow(ep.pid)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: PODCASTS[ep.pid].color, fontSize: 12.5, fontWeight: 700, fontFamily: FONT_BODY }}>{PODCASTS[ep.pid].name}</span>
              <ChevronRight size={13} color={T.muted} />
            </div>
          </button>
          <div style={{ color: T.muted, fontSize: 12, fontFamily: FONT_BODY, marginTop: 4 }}>{ep.date} · {mins(ep.dur)}</div>
          <div style={{ display: "flex", alignItems: "center", marginTop: 14, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 15, padding: "11px 14px" }}>
            <span style={{ color: T.muted, fontSize: 12.5, fontFamily: FONT_BODY, fontWeight: 600 }}>Rate this — it tunes your picks</span>
            <Thumbs vote={fb[ep.id]} onUp={() => voteUp(ep.id)} onDown={() => voteDown(ep.id, PODCASTS[ep.pid].name)} />
          </div>
          <p style={{ color: T.muted, fontSize: 13.5, lineHeight: 1.6, fontFamily: FONT_BODY, marginTop: 12 }}>{ep.desc}</p>
        </div>
      )}

      {/* Floating return pill while peeking */}
      {isForay && expanded != null && (
        <button onClick={backToNow} className="fadeup" style={{
          position: "absolute", bottom: 178, left: "50%", transform: "translateX(-50%)", zIndex: 5,
          display: "flex", alignItems: "center", gap: 6, background: T.surface2, border: `1px solid ${T.line}`,
          borderRadius: 20, padding: "9px 16px", cursor: "pointer", boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        }}>
          <ChevronDown size={14} color={T.amber} />
          <span style={{ color: T.text, fontSize: 12.5, fontWeight: 700, fontFamily: FONT_BODY }}>Back to now playing</span>
        </button>
      )}

      {/* Transport */}
      <div style={{ padding: "12px 24px 34px", borderTop: `1px solid ${T.line}`, flexShrink: 0, background: T.bg }}>
        {/* Scrubber with segment ticks */}
        <div onClick={seek} style={{ position: "relative", height: 22, display: "flex", alignItems: "center", cursor: "pointer" }}>
          <div style={{ position: "relative", width: "100%", height: 5, background: T.surface2, borderRadius: 3, overflow: "visible" }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(now.pos / total) * 100}%`, background: isForay ? segColor(curSeg) : T.amber, borderRadius: 3, transition: "background 0.4s" }} />
            {ticks.map((t, i) => (
              <div key={i} style={{ position: "absolute", left: `${t * 100}%`, top: -2.5, width: 2, height: 10, background: T.bg, borderRadius: 1 }} />
            ))}
            <div style={{ position: "absolute", left: `calc(${(now.pos / total) * 100}% - 6px)`, top: -3.5, width: 12, height: 12, borderRadius: 6, background: T.text, boxShadow: "0 1px 6px rgba(0,0,0,0.5)" }} />
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
          <span style={{ color: T.faint, fontSize: 11, fontFamily: FONT_BODY }}>{fmt(now.pos)}</span>
          <span style={{ color: T.faint, fontSize: 11, fontFamily: FONT_BODY }}>−{fmt(total - now.pos)}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: isForay ? 18 : 30, marginTop: 8 }}>
          {isForay && (
            <button onClick={() => jumpSeg(-1)} style={{ background: "none", border: "none", cursor: "pointer", padding: 6 }} title="Previous part">
              <SkipBack size={21} color={T.text} />
            </button>
          )}
          <button onClick={() => setPos(Math.max(0, now.pos - 15))} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, position: "relative" }}>
            <RotateCcw size={25} color={T.text} />
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 800, color: T.text, fontFamily: FONT_BODY, paddingTop: 3 }}>15</span>
          </button>
          <button onClick={() => setPlaying(!playing)} style={{
            width: 64, height: 64, borderRadius: 32, border: "none", cursor: "pointer",
            background: T.amber, display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 6px 24px ${T.amber}55`,
          }}>
            {playing ? <Pause size={26} color="#241A08" fill="#241A08" /> : <Play size={26} color="#241A08" fill="#241A08" style={{ marginLeft: 3 }} />}
          </button>
          <button onClick={() => setPos(Math.min(total, now.pos + 15))} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, position: "relative" }}>
            <RotateCw size={25} color={T.text} />
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 800, color: T.text, fontFamily: FONT_BODY, paddingTop: 3 }}>15</span>
          </button>
          {isForay && (
            <button onClick={() => jumpSeg(1)} style={{ background: "none", border: "none", cursor: "pointer", padding: 6 }} title="Next part">
              <SkipForward size={21} color={T.text} />
            </button>
          )}
        </div>
      </div>

      {fbSheet && (
        <FeedbackSheet
          label={fbSheet.label}
          onClose={() => setFbSheet(null)}
          onSubmit={() => { setFb((s) => ({ ...s, [fbSheet.key]: "down" })); setFbSheet(null); }}
        />
      )}
    </div>
  );
}

/* ---------------------------- Mini player ------------------------- */

function MiniPlayer({ now, playing, setPlaying, onOpen }) {
  const isForay = now.type === "foray";
  const total = isForay ? forayDur(now.item) : now.item.dur;
  const cur = isForay ? segAt(now.item, now.pos) : null;
  const curSeg = isForay ? now.item.segments[cur.idx] : null;
  return (
    <div style={{ padding: "0 10px 6px", flexShrink: 0 }}>
      <button onClick={onOpen} style={{
        width: "100%", background: T.surface2, border: `1px solid ${T.line}`, borderRadius: 16,
        padding: "9px 12px", cursor: "pointer", textAlign: "left", overflow: "hidden", position: "relative",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          {isForay
            ? (curSeg.kind === "narrator" ? <NarratorCover size={38} radius={11} /> : <Cover pid={curSeg.pid} size={38} radius={11} />)
            : <Cover pid={now.item.pid} size={38} radius={11} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: T.text, fontSize: 13, fontWeight: 600, fontFamily: FONT_BODY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {isForay ? now.item.title : now.item.title}
            </div>
            <div style={{ color: T.muted, fontSize: 11, fontFamily: FONT_BODY, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {isForay
                ? (curSeg.kind === "narrator" ? "Foray narrator" : `Now: ${PODCASTS[curSeg.pid].name}`)
                : PODCASTS[now.item.pid].name}
            </div>
          </div>
          <div onClick={(e) => { e.stopPropagation(); setPlaying(!playing); }} style={{ width: 38, height: 38, minWidth: 38, borderRadius: 19, background: T.amber, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {playing ? <Pause size={16} color="#241A08" fill="#241A08" /> : <Play size={16} color="#241A08" fill="#241A08" style={{ marginLeft: 2 }} />}
          </div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2.5, background: "transparent" }}>
          <div style={{ width: `${(now.pos / total) * 100}%`, height: "100%", background: T.amber }} />
        </div>
      </button>
    </div>
  );
}

/* ---------------------------- App shell --------------------------- */

export default function ForayApp() {
  const [screen, setScreen] = useState("login"); // login | welcome | prefs | main
  const [tab, setTab] = useState("home");
  const [now, setNow] = useState(null); // { type, item, pos }
  const [playing, setPlaying] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [showPid, setShowPid] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [createSubject, setCreateSubject] = useState("");
  const resume = { f1: 1180 };

  /* simulated playback (sped up ~33x so segment changes are visible) */
  useEffect(() => {
    if (!playing || !now) return;
    const iv = setInterval(() => {
      setNow((n) => {
        if (!n) return n;
        const total = n.type === "foray" ? forayDur(n.item) : n.item.dur;
        const next = n.pos + 5;
        if (next >= total) { setPlaying(false); return { ...n, pos: total }; }
        return { ...n, pos: next };
      });
    }, 150);
    return () => clearInterval(iv);
  }, [playing, now ? now.item : null]);

  const playForay = useCallback((f, pos = 0) => {
    setNow({ type: "foray", item: f, pos });
    setPlaying(true); setPlayerOpen(true);
  }, []);
  const playEpisode = useCallback((ep, pos = 0) => {
    setNow({ type: "episode", item: ep, pos });
    setPlaying(true); setPlayerOpen(true);
  }, []);
  const openShow = useCallback((pid) => setShowPid(pid), []);
  const startCreate = useCallback((subject) => {
    setCreateSubject(subject); setTab("create");
  }, []);
  const setPos = useCallback((p) => setNow((n) => (n ? { ...n, pos: p } : n)), []);

  const ctx = { playForay, playEpisode, openShow, setTab, startCreate, createSubject, setCreateSubject, resume };

  const navItems = [
    { id: "home", label: "Home", icon: Home },
    { id: "search", label: "Search", icon: Search },
    { id: "create", label: "Create", icon: Sparkles },
    { id: "library", label: "Library", icon: Library },
  ];

  return (
    <div style={{
      minHeight: "100vh", background: "radial-gradient(1200px 800px at 50% -10%, #241B2E, #0D0A10)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: "max(0px, calc((100vh - 850px) / 4)) 0",
      fontFamily: FONT_BODY,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700&family=DM+Sans:opsz,wght@9..40,400..800&display=swap');
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        button { font-family: inherit; }
        input::placeholder { color: ${T.faint}; }
        .hscroll::-webkit-scrollbar { display: none; }
        .hscroll { scrollbar-width: none; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .slideup { animation: slideup 0.32s cubic-bezier(0.32, 0.72, 0.2, 1); }
        @keyframes slideup { from { transform: translateY(60px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .fadeup { animation: fadeup 0.45s ease; }
        @keyframes fadeup { from { transform: translateY(14px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .eq i { display: block; width: 2.5px; background: ${T.amber}; border-radius: 1px; animation: eq 0.9s ease-in-out infinite; }
        .eq i:nth-child(1) { height: 6px; animation-delay: 0s; }
        .eq i:nth-child(2) { height: 10px; animation-delay: 0.25s; }
        .eq i:nth-child(3) { height: 7px; animation-delay: 0.5s; }
        @keyframes eq { 0%,100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }
        @media (prefers-reduced-motion: reduce) { .slideup, .fadeup, .spin, .eq i { animation: none; } }
      `}</style>

      <div style={{
        width: "min(400px, 100vw)", height: "min(850px, 100vh)",
        background: T.bg, borderRadius: "min(44px, 5vw)", overflow: "hidden",
        border: "1px solid #3A3145", boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
        display: "flex", flexDirection: "column", position: "relative",
      }}>
        <StatusBar />

        {screen === "login" && <LoginScreen onLogin={() => setScreen("welcome")} />}
        {screen === "welcome" && <WelcomeScreen onNext={() => setScreen("prefs")} />}
        {screen === "prefs" && <PrefsScreen onDone={() => setScreen("main")} />}

        {screen === "main" && (
          <>
            {tab === "home" && <HomeScreen ctx={ctx} />}
            {tab === "search" && <SearchScreen ctx={ctx} />}
            {tab === "create" && <CreateScreen ctx={ctx} />}
            {tab === "library" && <LibraryScreen ctx={ctx} />}

            {now && !playerOpen && (
              <MiniPlayer now={now} playing={playing} setPlaying={setPlaying} onOpen={() => setPlayerOpen(true)} />
            )}

            {/* Bottom nav */}
            <div style={{ display: "flex", borderTop: `1px solid ${T.line}`, background: T.bg, paddingBottom: 14, flexShrink: 0 }}>
              {navItems.map((n) => {
                const Icon = n.icon;
                const active = tab === n.id;
                return (
                  <button key={n.id} onClick={() => setTab(n.id)} style={{
                    flex: 1, background: "none", border: "none", cursor: "pointer",
                    padding: "11px 0 4px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  }}>
                    <Icon size={21} color={active ? T.amber : T.faint} strokeWidth={active ? 2.4 : 2} />
                    <span style={{ fontSize: 10.5, fontWeight: 600, fontFamily: FONT_BODY, color: active ? T.amber : T.faint }}>{n.label}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {playerOpen && now && (
          <Player
            now={now} playing={playing} setPlaying={setPlaying} setPos={setPos}
            onClose={() => setPlayerOpen(false)}
            onOpenShow={(pid) => setShowPid(pid)}
            onShare={() => setShareOpen(true)}
          />
        )}

        {shareOpen && now && (
          <ShareSheet target={now} onClose={() => setShareOpen(false)} />
        )}

        {showPid && (
          <ShowScreen pid={showPid} onBack={() => setShowPid(null)}
            onPlayEpisode={(ep) => { setShowPid(null); playEpisode(ep); }} />
        )}
      </div>
    </div>
  );
}
