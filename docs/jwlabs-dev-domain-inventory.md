# Every remaining reference to `jwlabs.dev` — a complete inventory

**Compiled 2026-08-25, against `origin/main` of all four repositories and against
the live systems.** This document is an **inventory only**. Nothing in it was
changed by the agent that wrote it, in any repository or any external system. A
separate pass does the fixing, and this document is that pass's worklist.

## The state this inventory was taken in

The website migration is **already done**, and this changes almost every verdict
below from what it would have been a day ago. Verified live, from this machine,
on 2026-08-25:

| Fact | How it was verified | Result |
|---|---|---|
| `jwlabs.ai` is the live primary site | `curl` of all 26 built pages | 26 × HTTP 200 |
| Certificate | `openssl s_client` | `subject=CN=jwlabs.ai`, Google Trust Services `WE1`, valid to 2026-11-23 |
| Served through Cloudflare, GitHub origin behind it | response headers | `server: cloudflare`, `CF-RAY`, and `x-github-request-id` still present |
| `jwlabs.dev` redirects | `curl -I` on 7 paths incl. `www` and a query string | 301 to the same path on `jwlabs.ai`, path **and query** preserved |
| Published contact address | `grep -o 'mailto:'` on all 26 live pages | `help@jwlabs.ai` only, on 25 of 26 (`/4a/features/` has no mailto by design) |
| Email Routing on the `jwlabs.ai` zone | DNS | MX `route1/2/3.mx.cloudflare.net`, SPF `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| Email Routing on the `jwlabs.dev` zone | DNS | still present, unchanged — `help@jwlabs.dev` still accepts mail |
| No script, no email obfuscation on the live site | `grep -c '<script'`, `grep -c email-protection` on 26 pages | 0 and 0 |
| The repo root is not served | `curl` of `/README.md`, `/src/4a-privacy-policy.md` | 404, 404 |

Two consequences that shape the whole list:

1. **`help@jwlabs.dev` outside the website is now a MUST change.**
   `help@jwlabs.ai` is live and verified, so the old address is no longer the
   only working one.
2. **Nothing is broken right now.** Every stale `jwlabs.dev` URL still resolves,
   because the 301 exists. That is exactly what makes this list worth doing
   *before* somebody tidies up Cloudflare — the failures below are all
   **deferred** failures, not present ones.

## What must NOT move

Three categories deliberately keep the `.dev` spelling, and each costs something
real if a fix pass ignores that:

1. **The repository name and the organisation name.** The repository *is* named
   `jwlabs.dev` and the GitHub organisation *is* named `JW-Incorporated`. Every
   `github.com/JW-Incorporated/...`, `jw-incorporated.github.io/...` and
   `jw-incorporated.github.io/jwlabs.dev/` URL is **correct**. There are 200+ of
   these across the four repos and not one is an error.
2. **Historical records.** `docs/DECISIONS.md`, superseded `HUMAN-ACTIONS`
   items, the Apple-rejection post-mortem's past-tense analysis, and eight closed
   pull requests. A decision log that rewrites its own past is worthless. The
   exact lines are listed under [Historical records](#historical-records--must-not-change).
3. **The Cloudflare redirect rule and the `jwlabs.dev` zone itself.** Deleting
   the zone takes out the redirect *and* the still-working `help@jwlabs.dev`
   alias in one move.

---

## Summary

### By verdict

| Verdict | Items | What it means |
|---|---|---|
| **MUST change** | **25** | Live-facing today: a URL a store or reviewer reads, an identity claim made to Apple, a verification command that now measures a redirect, or prose that will mislead the next agent into re-breaking something. |
| **MUST NOT change** | **12** | Historical record, intentional repo/org spelling, or live infrastructure whose whole job is to be the old domain. |
| **IN FLIGHT** | **1** (52 lines, 19 files, 5 renamed paths) | The `dev.jwlabs.foura` bundle id and Java package. Another agent is moving it to `ai.jwlabs.foura` right now. Do not touch. |
| **DEFER** | **6** | Real, but a founder decision or a follow-up, not a mechanical find-and-replace. |
| **Cannot verify from here** | **7** | Behind a login. Listed with who must check and what to click. |

### By repository / system

| Where | `jwlabs.dev` lines | `dev.jwlabs` lines | Verdict summary |
|---|---|---|---|
| `foray` (public) | **22** in 3 files | **52** in 19 files + 5 renamed paths | 16 MUST · 6 MUST NOT · 1 IN FLIGHT (grouped) |
| `transcript-farm` (private) | **0** | **0** | Clean. One adjacent finding (inherited identity). |
| `jwlabs.dev` (public, the website) | **31** in 3 files | 0 | 4 MUST (stale prose, not the live pages) · 2 MUST NOT (the runbook itself) · 1 MUST (repo description) · 1 DEFER |
| `Swift2` (public) | **0** | **0** | Clean. One DEFER (`com.jwincorporated.swift2`). |
| External systems | — | — | 4 MUST · 3 MUST NOT · 3 DEFER · 7 cannot verify |

**The live website itself is clean.** Verified rather than assumed: all 26 served
pages, the `CNAME`, and `MAIL` in `build-md.mjs`. The 31 residual mentions in that
repo are all in `README.md`, `build.mjs` and `build-md.mjs` — none of which are
served — and most of them are the migration runbook doing its job.

### The three most dangerous if missed

1. **`docs/apple-enrollment-website.md:74` in foray — `help@jwlabs.dev`
   presented as "a work email address associated with your organization's domain
   name … the same domain as this site".** Both halves are now false. That
   sentence is what a founder reads while re-filling Apple's enrollment form for
   `DVNC3U5GMU`. Typing `help@jwlabs.dev` into the work-email field next to a
   website of `jwlabs.ai` manufactures a *domain/organisation mismatch* — which
   is the precise defect Apple already rejected this enrollment for once. The
   whole document exists to stop that recurring, and it is currently the thing
   that would cause it.

2. **`HUMAN-ACTIONS.md:1595–1597` in foray — the three store URLs, on
   `jwlabs.dev`, each annotated "HTTP 200".** This is the table `#42` (store
   listings) is meant to quote. Both stores re-check a Privacy Policy URL for the
   life of the app. A listing published pointing at `jwlabs.dev/4a/privacy/`
   works only as long as one Cloudflare redirect rule on a zone nobody is
   thinking about survives — and the "HTTP 200" annotation is already wrong (it
   is a 301). A dead privacy URL after publication is a compliance problem, not a
   cosmetic one.

3. **The Google site-verification TXT record, which exists on `jwlabs.dev` and
   NOT on `jwlabs.ai`.** `google-site-verification=O2BedsLi5-f3mZUkNskqnq-ZyODnr58jZcJ1pqrGiFg`
   resolves on the old zone; `jwlabs.ai` has no verification TXT at all. Whatever
   that token verifies (Search Console, and Play Console's verified-website
   field) is bound to the domain being retired. It is invisible from every
   repository, no grep can find it, and it fails silently: the day the old zone
   goes, ownership of the company domain becomes unproven at Google.

---

## Search methodology — stated so you can see the shape of what might be missed

Everything below ran against **`origin/main`** (`git grep <pattern> origin/main`),
never a working tree, after `git fetch` on all four repos. Commits inventoried:
foray `09d0d38`, transcript-farm `160abc3`, jwlabs.dev `2ed934f`, Swift2
`803c6a69`.

**Why `origin/main` and not the checkouts:** foray has **71 worktrees** sharing
one repository. Reporting a branch's contents as main's would be the easiest way
to be confidently wrong here. Two branches were then inspected *deliberately and
separately*, and are labelled as branches wherever they appear: the in-flight
bundle-id branch, and this document's own branch.

### Patterns run, in every repository

| Pattern | Why | Hits |
|---|---|---|
| `jwlabs` (case-insensitive) | the broad net; catches `.ai`, `.com`, `JWLABS`, typos | foray 74, website 196, tf 0, Swift2 0 |
| `jwlabs\.dev` | the literal | 22 / 31 / 0 / 0 |
| `jwlabs\.ai` | the destination, to spot half-done edits | website only |
| `jwlabs\.com` | a domain the company does **not** own | 1 (foray, hypothetical future purchase) |
| `dev\.jwlabs`, `dev/jwlabs` | reverse-DNS bundle id and the Java source path | 52 lines + 5 paths, foray only |
| `@jwlabs`, `help@`, `contact@`, `support@` | any address on the domain | `help@jwlabs.dev` ×2 (foray) |
| `[\w.%+-]+@[\w.-]+\.\w{2,}` extracted and tallied per repo | to see *every* address rather than the ones I guessed | see [addresses](#every-email-address-in-every-repo) |
| `jw-?labs`, `jw labs`, `jw-?incorporated`, `JW Labs LLC` | the entity name, and the entity name that does not exist | foray/Swift2/website prose |
| `andsYWJz`, `YWp3bGFic`, `YWJqd2xhYnM`, `aGVscEBqd2xhYnM` | base64 of `jwlabs.dev` and `help@jwlabs.dev` at all three byte offsets | **0** |
| `jwlabs%2E`, `%6Aw%6Cabs`, `&#106;`, `&#46;dev` | percent-encoded and HTML-entity forms | **0** |
| `"jw"`, `"labs"`, `"dev"`, `"ai"`, `+ ".dev"`, `${…}.dev` | **runtime assembly** — a host built from parts, which a literal grep cannot see | **0** (two false positives: an acronym set in `app.js`, a CSS class) |
| `(SITE\|BASE\|HOST\|ORIGIN\|DOMAIN\|APEX)_?(URL\|HOST\|NAME) =` | a host held in a constant and reused | 10 constants, none naming the company domain |
| `git grep -a` (binary-inclusive) | an icon, a `.mobileprovision`, a compiled asset carrying the string | **0** binary matches |

**File types covered** by the above, because `git grep` is extension-blind and I
constrained nothing except where noted: `.md`, `.mjs`, `.js`, `.ts`, `.tsx`,
`.py`, `.json`, `.yml`/`.yaml`, `.gradle`, `.xml`, `.plist`, `.html`, `.css`,
`.java`, `.txt`, `.gitignore`, `.gitattributes`, `CNAME`, `.nojekyll`, workflows,
manifests, service workers, and test fixtures.

### Reading, not grepping

A literal search cannot see a URL assembled at runtime, so these were **read**:

- `tools/segments/politeness.mjs` (foray) — since #318 it owns **all** outbound
  identity: four User-Agent strings, the contact address and the repo URL sent to
  podcast hosts on every request. **Result: no `jwlabs` string of any kind.**
  `CONTACT = "wjduvall@gmail.com"`, `REPO_URL = "https://github.com/JW-Incorporated/foray"`.
  See [adjacent findings](#adjacent-findings--not-jwlabsdev-but-found-while-looking).
- `farm/identity.py` (transcript-farm) — the worker that *fetches* those
  constants from foray. Confirmed it inherits `CONTACT`, and confirmed what it
  inherits today.
- `build.mjs` + `build-md.mjs` (website) — the two files that could interpolate a
  host into 26 pages. `MAIL`, `ORG`, `STUDIO`, `ORG_FORM`, `ORG_FORMED` are the
  only substituted facts; `MAIL = "help@jwlabs.ai"`.
- `docs/legal/privacy-policy.md` + `docs/legal/data-safety.md` (foray) — the
  upstream the website snapshots. See [the snapshot chain](#the-privacy-policy-snapshot-chain).
- `app.js`, `index.html`, `sw.js`, `manifest` (foray) — every `https://` literal
  extracted and listed; no company-domain link exists in the shipped client.

### Live and API checks

- DNS: A/AAAA, MX, TXT (SPF, site-verification), `_dmarc`,
  `cf2024-{1,2,3}._domainkey`, `www` — on **both** zones, via `8.8.8.8`.
- HTTP: all 26 built pages on `jwlabs.ai`; 7 redirect probes on `jwlabs.dev`
  including `www` and a query string; 4 must-404 paths; the Pages origin URL.
- TLS: certificate subject/issuer/dates on `jwlabs.ai`.
- RDAP: both domains (registrar, registration and expiry dates, nameservers,
  registrant redaction state).
- GitHub API: Actions **variables** (readable) and **secret names** (values are
  not readable) for all four repos; repo `homepage` and `description`; the Pages
  configuration of each repo; the organisation profile; and an
  org-wide issue/PR search for `jwlabs.dev`, `jwlabs.ai`, `help@`, `domain` and
  `bundle id`, in both open and closed states.
- The live third-party surfaces the repos point at: `foray-web-seven.vercel.app`
  and `www.longlivets.com` (plus its `/terms` and `/privacy`), grepped for
  `jwlabs`, `JW Incorporated` and any `mailto:`.

### What this methodology still cannot see

Stated plainly, because "exhaustive" should mean "and here is the boundary":
anything inside a dashboard I cannot log into (Cloudflare, Apple, Google, Vercel,
Supabase), the **values** of GitHub secrets, private repositories other than the
two I have, any string held only in a founder's browser history or a saved store
draft, and any git object not reachable from `origin/main` (old branches, closed
PR diffs). Those are enumerated under
[Could not verify](#could-not-verify--and-who-must-check).

---

## foray — `jwlabs.dev` (22 lines, 3 files)

`C:\Users\wjduv\Desktop\Vibe Coding\foray`, `origin/main` @ `09d0d38`.

### `HUMAN-ACTIONS.md` — item #25, "Buy the company domain … — DONE"

| # | Line | Exact string | Kind | Verdict | What breaks if missed |
|---|---|---|---|---|---|
| F1 | `HUMAN-ACTIONS.md:1595` | `` \| Privacy Policy URL (both stores, required) \| https://jwlabs.dev/4a/privacy/ \| HTTP 200 \|`` | **URL a store or reviewer checks** | **MUST change** → `https://jwlabs.ai/4a/privacy/`. This is the table #42 quotes into two live store listings. | A published listing whose required privacy URL survives only via one Cloudflare rule on a retired zone. Both stores re-check it after publication; a dead one is a compliance action, not a cosmetic bug. The "HTTP 200" annotation is *already* false — it is a 301. |
| F2 | `HUMAN-ACTIONS.md:1596` | `` \| Support URL (Apple, required) \| https://jwlabs.dev/4a/support/ \| HTTP 200 \|`` | URL a store or reviewer checks | **MUST change** → `jwlabs.ai` | Apple requires the Support URL for the life of the app. Same failure as F1. |
| F3 | `HUMAN-ACTIONS.md:1597` | `` \| Marketing URL (optional) \| https://jwlabs.dev/4a/ \| HTTP 200 \|`` | URL a store or reviewer checks | **MUST change** → `jwlabs.ai` | Optional field, so the smallest of the three — but it is in the same table and will be copied in the same sitting. |
| F4 | `HUMAN-ACTIONS.md:1589` | ``> **RESOLVED, AND THE ANSWER IS "DO NOT BUY ANYTHING".** `jwlabs.dev` was purchased`` … "and the site is built, deployed and verified live" | documentation prose (resolution of a live item) | **MUST change** — split it. "purchased 2026-08-24" is a **historical fact and must stay**; "the site is built, deployed and verified live" now describes `jwlabs.ai`. | A reader concludes the live site is on `.dev` and writes it into a store listing or an Apple form. This paragraph is the item's answer, so it is the paragraph that gets read. |
| F5 | `HUMAN-ACTIONS.md:1621` | ``> GitHub never issued a certificate for `jwlabs.dev`, so the origin still presents`` … "Turning the DNS records grey brings back a certificate error that … users cannot click through" | infrastructure config prose | **MUST change** — the warning is still true *in kind* but now applies to `jwlabs.ai`, and the `.dev` hostname is no longer served by Pages at all (Pages spends its one custom domain on `jwlabs.ai`). | An operator greys the clouds on the wrong zone, or believes the `.dev` proxy is still load-bearing for the site rather than for the redirect. The real current dependency is: the redirect rule needs `jwlabs.dev` to keep resolving to Cloudflare. |
| F6 | `HUMAN-ACTIONS.md:1615` | ``> then `jwlabs.com` or similar, matching the entity.`` | documentation prose | **MUST NOT change** — this is about a hypothetical future `.com` purchase, not the `.dev` domain. | Nothing. Flagged only because a `jwlabs`-wide grep hits it and a careless pass would "fix" it to `.ai`, destroying the sentence's meaning. |

Also in #25 and worth one line to whoever edits it: the item's header says
`— DONE` and `**Tag:** [DONE 2026-08-25]`, but the item still ends with
`**Status:** OPEN` on line 1673. Not a domain reference; noted because the fix
pass will be editing exactly those lines.

### `docs/DECISIONS.md` — historical, do not touch

| # | Line | Exact string | Kind | Verdict | What breaks if missed |
|---|---|---|---|---|---|
| F7 | `docs/DECISIONS.md:836` | ``not own. `jwlabs.dev` was purchased 2026-08-24, so `dev.jwlabs` is a prefix we can actually`` | documentation prose (decision log) | **MUST NOT change** — the record of why the 2026-08-24 ruling was made, and it was correct on the day. | Nothing breaks by leaving it. *Changing* it breaks the decision log's only value: that its past is not rewritten. |
| F8 | `docs/DECISIONS.md:904` | ``does not exist, and `jwlabs.dev` is already owned — but which domain hosts the`` | documentation prose (decision log) | **MUST NOT change** | As F7. |

### `docs/apple-enrollment-website.md` — 14 lines, and the highest-stakes file here

Context that decides the verdicts: this document was **moved into foray on
2026-08-25** (PR #340) precisely because it was publicly readable from the site
Apple was reviewing. It is now unserved — verified: `jwlabs.ai/docs/…` and
`jwlabs.ai/README.md` both 404. So it is safe to edit; it is **not** a pinned or
published artefact. But it is the checklist the enrollment resubmission is argued
from, which makes stale claims in it more dangerous than stale prose elsewhere.

| # | Line | Exact string | Kind | Verdict | What breaks if missed |
|---|---|---|---|---|---|
| F9 | `:2` | ``> the `jwlabs.dev` repository. GitHub Pages serves that repository's branch root,`` | documentation prose (incident record) | **MUST NOT change** — past tense, and the *repository* is still named `jwlabs.dev` anyway. | Nothing. |
| F10 | `:3` | ``> so it was publicly readable at `jwlabs.dev/docs/apple-enrollment-website.md` --`` | incident record | **MUST NOT change** — the URL that leaked, as it was. | Nothing. (For the record: that path now 301s to `jwlabs.ai/docs/…`, which 404s. The leak is closed on both domains.) |
| F11 | `:74` | ``your organization's domain name.** That is `help@jwlabs.dev`, and it is the same`` (…"domain as this site") | **identity string presented to a reviewer** | **MUST change** → `help@jwlabs.ai`. **The single most dangerous line in this inventory.** | A founder fills Apple's work-email field with an address on a domain that is no longer the website's domain — recreating the organisation/domain mismatch that got `DVNC3U5GMU` rejected. The sentence's own claim ("the same domain as this site") becomes the counter-evidence. |
| F12 | `:85` | ``record is **JW Labs LLC**. So a reviewer checking whether `jwlabs.dev` was`` | documentation prose (post-mortem, past tense) | **MUST NOT change** — this analyses what a reviewer saw *before* 2026-08-25. | Nothing. |
| F13 | `:131` | ``` `jwlabs.dev`. **The founder's decision not to publish a postal address does not** ``` | documentation prose (present-tense reasoning) | **MUST change** → `jwlabs.ai` | The sentence reasons about the domain currently under review. Wrong domain = an argument that does not apply to the site Apple will look at. |
| F14 | `:175` | ``\| 1 \| Publicly reachable over HTTPS… \| [stated] \| Apex jwlabs.dev serves 200 over TLS. GitHub Pages origin, Cloudflare terminating TLS. …`` | evidence table asserting current state | **MUST change** → `jwlabs.ai` serves 200 (verified today); `jwlabs.dev` now 301s. | Checklist item 1 is "publicly reachable over HTTPS". The evidence cell would have a reviewer, or the next agent, verify the *redirect* and record a pass for the wrong host. |
| F15 | `:180` | ``schema.org `Organization` microdata in the site footer: … `url` = jwlabs.dev, `email` = the contact address.`` | evidence table / machine-readable org association | **MUST change** → `url` = `jwlabs.ai` (the live footer already emits `jwlabs.ai`; the doc lags). | Item 6 is the machine-readable domain↔organisation association Apple can check without asking anyone. If the doc says `.dev` and the site says `.ai`, nobody notices when the microdata *does* regress — the doc has stopped being a tripwire. |
| F16 | `:184` | ``\| 10 \| … \| help@jwlabs.dev, rendered as a real mailto: in static HTML on every page, plus a dedicated /contact/. \|`` | identity string / evidence table | **MUST change** → `help@jwlabs.ai`. Verified: all 25 mailto-bearing live pages emit `help@jwlabs.ai`. | Item 10 is "a working contact route on the organization's own domain". The claim is falsifiable in one `curl` and currently false, on the checklist item most likely to be spot-checked. |
| F17 | `:228` | ``4. **Whether `jwlabs.dev` is registered to JW Labs LLC** rather than to an`` | open question for the founder | **MUST change** — extend to cover **both** domains, and `jwlabs.ai` first, since that is the one Apple now reviews. | The open question is asked about the wrong domain, so it gets answered about the wrong domain. RDAP shows the registrant **redacted** on both (Cloudflare privacy) — so this cannot be settled from outside; see [X6](#could-not-verify--and-who-must-check). |
| F18 | `:263` | ``result of from here is WHOIS: if `jwlabs.dev` is registered to an individual`` | open question / reasoning | **MUST change** → same as F17 | As F17. |
| F19 | `:273` | ``- **The site's own source is served.** `https://jwlabs.dev/src/...` returns the`` | infrastructure finding, now resolved | **MUST change** — record it as fixed. Verified: `https://jwlabs.ai/src/4a-privacy-policy.md` → **404**; Pages now serves `docs/` only (website PR #4). | A resolved defect left reading as open. Somebody re-fixes it, or worse, distrusts the rest of the document because one of its findings is visibly stale. |
| F20 | `:321` | ``curl -sS "https://jwlabs.dev$p" \|`` (inside a per-page loop) | verification command | **MUST change** → `https://jwlabs.ai$p` | Run today, this loops over every page fetching a **301 with an empty body** and reports every content assertion as failing — or, if a check is written loosely, passes on Cloudflare's redirect page. Either way the checklist stops measuring the site. |
| F21 | `:325` | ``curl -sS https://jwlabs.dev/ \| grep -o 'mailto:…'  # must be the real address`` | verification command | **MUST change** → `jwlabs.ai` | Returns nothing (301 body). "No mailto found" reads as a catastrophic regression on a site that is in fact correct. |
| F22 | `:326` | ``curl -sS https://jwlabs.dev/ \| grep -c 'JW Incorporated'  # must be 0`` | verification command | **MUST change** → `jwlabs.ai` | This check **cannot fail** against a redirect: the 301 body contains no company name, so it always reports 0 and always passes. A guard that cannot fail is worse than no guard — and "JW Incorporated" appearing on a page is the exact defect Apple rejected the enrollment over. |

---

## foray — `dev.jwlabs` / `dev/jwlabs` (52 lines, 19 files, 5 renamed paths) — **IN FLIGHT**

**Verdict: IN FLIGHT. Do not touch any of it.** Another agent is moving the
bundle id from `dev.jwlabs.foura` to **`ai.jwlabs.foura`** right now, following
the domain. Its work is on branch **`android/bundle-id-jwlabs-ai`** in worktree
`C:\Users\wjduv\AppData\Local\Temp\wtbid` — three commits (`cf025da`, `8423dce`,
`fa66166`), 20 files changed.

**Kind:** bundle id / package name. **Not** a URL and not an identity string sent
to a host — but permanent once published to a store, which is why it is being
changed now rather than later.

The live-configuration sites, so coverage can be audited rather than trusted:

| File | Line(s) | What it is |
|---|---|---|
| `mobile/capacitor.config.json` | 2 | `"appId": "dev.jwlabs.foura"` — the shipped id |
| `.github/workflows/ios-build.yml` | 126 | `APP_ID: dev.jwlabs.foura` — what `simctl` is given |
| `.github/workflows/android-build.yml` | 376, 390 | two fully-qualified needles the job greps for |
| `mobile/plugins/foray-audio/android/build.gradle` | 108 | `namespace = "dev.jwlabs.foura.audio"` |
| `.../android/src/main/AndroidManifest.xml` | 47 | `android:name="dev.jwlabs.foura.audio.PlaybackKeepAliveService"` |
| `.../java/dev/jwlabs/foura/audio/*.java` | 5 × `package` lines + `PlaybackKeepAliveService.java:121` (`ACTION_TRANSPORT`) | plus the **directory path itself**, which needs a `git mv` |
| `tools/mobile/shell-invariants.test.mjs` | 21 lines | the pinned assertions |
| `tools/mobile/android-workflow.test.mjs` | 388, 402 | workflow-text assertions |
| `test/app-name.test.js` | 25, 690 | the pinned `appId` |
| `docs/android-lock-screen.md` · `docs/android-native-code.md` · `docs/mobile-shell.md` · `ios/README.md` · `HUMAN-ACTIONS.md:935,1139` | 8 lines | current-state documentation |

**Audited against the in-flight branch: it covers all of the above**, including
the `git mv` of the Java tree, both workflow needles, and — newly — a test
(`tools/mobile/ios-workflow.test.mjs`) that derives `APP_ID` from
`capacitor.config.json` so the third copy cannot drift silently again. The
`dev.jwlabs` strings it *leaves behind* are all superseded prose in
`docs/DECISIONS.md` and `HUMAN-ACTIONS.md`, which is correct.

**Two things its scope does not cover, and they are this inventory's job, not
its:**

1. **The domain half.** The branch does not touch
   `docs/apple-enrollment-website.md` (F9–F22) or the #25 store-URL table
   (F1–F5). Confirmed by diff: those files are not in it.
2. **The branch is not pushed.** `origin/android/bundle-id-jwlabs-ai` does not
   exist, and foray has **zero open PRs**. If that agent stops, `main` keeps
   `dev.jwlabs.foura` and nothing records that a re-ruling happened. Whoever acts
   on this document should confirm the bundle-id PR landed before assuming it.

---

## transcript-farm — clean

`C:\Users\wjduv\Desktop\Vibe Coding\transcript-farm`, `origin/main` @ `160abc3`.

**Zero** occurrences of `jwlabs` in any form, encoded or assembled. The only
matches for the broader identity patterns are
`github.com/JW-Incorporated/{foray,transcript-farm}` URLs and
`FORAY_OWNER_REPO = "JW-Incorporated/foray"` in `farm/identity.py:91` — all
**intentional and correct** (repo/org names).

This is the repo the brief flagged as inheriting foray's outbound identity, so it
was read rather than only grepped. `farm/identity.py` fetches
`data/outbound-identity.json` from foray's `main`, falling back to parsing
`tools/segments/politeness.mjs`. It therefore inherits `CONTACT` — which is
`wjduvall@gmail.com`, not any `jwlabs` address. **Nothing to change here for this
migration.** Two adjacent observations are recorded
[below](#adjacent-findings--not-jwlabsdev-but-found-while-looking).

---

## jwlabs.dev (the website repo) — the live pages are clean; three unserved files are not

`C:\Users\wjduv\Desktop\Vibe Coding\jwlabs.dev`, `origin/main` @ `2ed934f`.

**Verified clean, not assumed:** all 26 served pages carry zero `jwlabs.dev`
strings and exactly one address, `help@jwlabs.ai`; `docs/CNAME` is `jwlabs.ai`;
`build-md.mjs:19` is `export const MAIL = "help@jwlabs.ai";`. The 31 residual
mentions are confined to `README.md` (28), `build.mjs` (2) and `build-md.mjs`
(1) — **none of which are served** (`/README.md` → 404, verified).

Most of those 28 are the cutover runbook legitimately naming the old domain: the
redirect rule, the certificate history, the `curl` checks that *should* target
`jwlabs.dev` and expect a 301 (README:268, 389–391 — all verified true today),
and the repository/Pages spelling. Those are **MUST NOT change**.

Four are stale in a way that will actively mislead:

| # | Line(s) | Exact string / claim | Kind | Verdict | What breaks if missed |
|---|---|---|---|---|---|
| W1 | `README.md:14–23` (the string is at `:15`) | ``Email Routing is configured on the `jwlabs.dev` zone only, so `help@jwlabs.ai` would accept nothing and drop mail silently`` … "`MAIL` in `build-md.mjs` was left alone at cutover and the site publishes a `.dev` address on a `.ai` site on purpose" | documentation prose (a deliberate-decision note) | **MUST change** — false on both counts. `jwlabs.ai` has MX + SPF and routing is enabled; `MAIL` **is** `help@jwlabs.ai`; the live site publishes no `.dev` address. The block is also internally contradictory: its own heading says "The contact address is still `help@jwlabs.ai`". | This paragraph *instructs the next agent not to fix* something already fixed — and asserts that the live address drops mail silently. The plausible reactions are both bad: revert `MAIL` to `.dev` to "match the docs", or stop trusting `help@jwlabs.ai` and stop testing it. |
| W2 | `README.md:429–431` | ``- **The site will visibly publish a `.dev` address on a `.ai` site** until Email Routing exists on the new zone. That is a deliberate, documented mismatch, not an oversight — see the note at the top of this file before "fixing" it.`` | documentation prose | **MUST change** — the condition it is gated on ("until Email Routing exists on the new zone") has been met. | Same as W1, and this copy explicitly tells the reader to consult W1 before fixing it. Two mutually-reinforcing stale warnings. |
| W3 | `README.md:592–596` | ``**The `jwlabs.dev` zone stays.** … it keeps its MX records, because Email Routing for `help@jwlabs.ai` lives there`` … "the company's only mailbox" | infrastructure config prose | **MUST change** (partially). The **conclusion is still right and must survive**: do not delete the zone — the redirect needs it. The *reason* is now wrong: routing exists on `jwlabs.ai`, and the old zone's value is the redirect plus the still-working `help@jwlabs.dev` alias. | If the stated reason is falsified, somebody decides the whole warning is obsolete and deletes the zone — killing the 301 for every store URL and Apple form still pointing at `.dev`. The right conclusion has to stop resting on a wrong premise. |
| W4 | `README.md:601`, `build.mjs:32–33`, `build-md.mjs:179` | ``the site renders identically at `https://jwlabs.ai/` and at `https://jw-incorporated.github.io/jwlabs.dev/``` | documentation prose (the `jwlabs.dev` here is the **repo name** — correct) | **MUST change** (accuracy only, and keep the repo-name spelling). Measured: `https://jw-incorporated.github.io/jwlabs.dev/` returns **301 → `http://jwlabs.ai/`** — Pages redirects to the custom domain, so the claim is no longer testable as written. | The stated benefit ("the site can be reviewed the moment it is pushed, before DNS propagates") no longer holds, and the next person to rely on it will conclude the build is broken. Note also that the redirect target is **`http://`**: GitHub Pages has `https_enforced: false` on this repo (see W6). |

| # | Item | Kind | Verdict |
|---|---|---|---|
| W5 | `README.md:406` — ``both are `jwlabs.dev/4a/...` today … change them to `jwlabs.ai``` (cutover step 14, App Store Connect / Play Console) | documentation prose (the action item) | **MUST NOT change** — this *is* the instruction to fix the external systems. One qualification for whoever reads it: there are no store listings yet (no Apple membership, `HUMAN-ACTIONS` #19 open), so what actually holds the old URL today is the **Apple enrollment form** ([X8](#could-not-verify--and-who-must-check)), not App Store Connect. |
| W6 | The other ~20 `jwlabs.dev` lines in `README.md` (`:6`, `:10`, `:179–180`, `:219`, `:235`, `:238–244`, `:252`, `:258`, `:268`, `:280`, `:297`, `:312–313`, `:389–391`, `:413`, `:427`, `:564`, `:583`) | infrastructure config + documentation prose | **MUST NOT change** — the redirect runbook, the certificate history, the per-zone Cloudflare settings, and the `curl` probes that must target the old host. Verified accurate today. |
| W7 | **GitHub repository description** (not a file): "The company website for **JW Incorporated**: 4a, a podcast curator, and longlive." | **identity string published to third parties** — visible on the public repo page, in search results, and in the GitHub API | **MUST change** → "JW Labs LLC". Not a `.dev` string, but the same defect class, and it is the one that got the Apple enrollment rejected: a public company asset naming an entity that does not exist. Read via `gh api repos/JW-Incorporated/jwlabs.dev --jq .description`. |
| W8 | **GitHub Pages `https_enforced: false`** on this repo (`gh api repos/JW-Incorporated/jwlabs.dev/pages`) | infrastructure config | **DEFER** — probably a leftover of the `.dev` certificate that GitHub never issued. Harmless today (Cloudflare terminates TLS and `.ai` is not HSTS-preloaded like `.dev`), but it is why the Pages-origin redirect lands on `http://`. Worth a founder's click once the `jwlabs.ai` certificate question in `README.md:179` is settled. |

---

## Swift2 — clean, with one deferred cousin

`C:\Users\wjduv\Desktop\Vibe Coding\Swift2`, `origin/main` @ `803c6a69`.

**Zero** occurrences of `jwlabs` in any form. Verified beyond the literal: no
encoded forms, no runtime assembly, no `@jwlabs` address. Its published surface
uses its own domain — `hello@`, `legal@`, `privacy@`, `submissions@longlivets.com`,
verified live on `www.longlivets.com/terms` and `/privacy` — and its outbound
User-Agent (`apps/worker/src/sources/reddit-rss.ts:48`) names
`https://longlivets.com` and `github.com/JW-Incorporated/swift2/issues`.

| # | Item | Kind | Verdict |
|---|---|---|---|
| S1 | `com.jwincorporated.swift2` — `apps/mobile/app.json:14,21`, `apps/mobile/README.md:33`, `apps/mobile/docs/mobile-shipping-checklist.md:26,33,101,136` | bundle id / package name | **DEFER**, and deliberately out of this migration's scope. It is the *same* defect foray's #15 re-ruled twice (a reverse-DNS prefix for a domain the company does not own — `jwincorporated.com` is explicitly NOT to be bought, `HUMAN-ACTIONS.md:1599`). Not published yet (`swift2` #531 is open), so it is still cheap to change; but it is a founder ruling about a *different* app, not a find-and-replace this pass should perform. |
| S2 | `JW Labs LLC` in `apps/web/lib/longlive/legal.ts:79,84` and its test at `legal.test.ts:88` | identity string, published | **MUST NOT change** — correct entity name, correctly pinned by a test. Listed so a `jwlabs`-wide grep pass does not "unify" it into a domain. |

---

## External systems

Cannot be grepped, and where migrations actually fail. Each row says how to
check it.

### Cloudflare — the `jwlabs.dev` zone

| # | Item | Kind | Verdict | Verified? |
|---|---|---|---|---|
| X1 | **TXT `google-site-verification=O2BedsLi5-f3mZUkNskqnq-ZyODnr58jZcJ1pqrGiFg`** on `jwlabs.dev`. **`jwlabs.ai` has no verification TXT at all.** | infrastructure config / third-party ownership proof | **MUST change** — add the equivalent record to the `jwlabs.ai` zone (Google will issue a token for the new property; do not copy this one blindly), then re-verify the property. **Do not delete the old record until the new one verifies.** | **Yes** — `Resolve-DnsName -Type TXT` on both zones, via `8.8.8.8`. |
| X2 | The **301 redirect rule** (`jwlabs.dev/*` → `https://jwlabs.ai/$1`) | infrastructure config | **MUST NOT change / MUST NOT delete** — it is the only thing keeping every stale URL in this document alive. | **Yes** — 7 probes: apex, `www`, `/4a/`, `/4a/privacy/`, `/4a/support/`, `/contact/`, and `?x=1`. All 301, path and query preserved. |
| X3 | **MX** (`route1/2/3.mx.cloudflare.net`) + **SPF** on `jwlabs.dev`, i.e. Email Routing for `help@jwlabs.dev` | infrastructure config | **MUST NOT change yet** — keep the old address accepting mail for as long as documents in the wild still name it (Apple's enrollment record does). Retire only after X8 is done and a grace period has passed. | **Yes** — DNS. |
| X4 | **Email Routing rules and destination address on the `jwlabs.ai` zone** — which address `help@jwlabs.ai` actually forwards to, and whether the destination is verified | infrastructure config | Verify. MX and SPF exist, which means the zone is configured; the *rule* and its destination are dashboard-only. | **Partly.** DNS confirms MX + SPF. **A human must send a test message to `help@jwlabs.ai` and confirm it arrives** — the website README's own step 13. |
| X5 | **DKIM**: `cf2024-1._domainkey` resolves on **neither** zone (SOA, not TXT/CNAME); `_dmarc` exists on neither | infrastructure config | **DEFER** — identical on both zones, so nothing regressed in the migration, and Cloudflare Email Routing forwards fine without it. Raised because the brief expected DKIM to be provisioned and it is not publicly resolvable. | **Yes** — DNS, both zones, three selectors + `_dmarc`. |

### Cloudflare — registrar

| # | Item | Kind | Verdict | Verified? |
|---|---|---|---|---|
| X6 | Both domains are at **Cloudflare Registrar**, both with **registrant `DATA REDACTED`**. `jwlabs.dev`: registered 2026-08-24, expires **2027-08-24**. `jwlabs.ai`: registered 2026-08-25, expires **2028-08-25** (`.ai` sells in 2-year terms). Nameservers `denver`/`gigi.ns.cloudflare.com` on both. | infrastructure config / legal identity | **MUST verify (founder).** Two things: (a) the registrant **organisation** field must read **JW Labs LLC** on both, because F17/F18 raise exactly this as an open Apple question and Cloudflare's privacy redaction means neither Apple nor anyone else can confirm it from WHOIS; (b) **auto-renew on `jwlabs.ai`** — the live company site and every 301 destination now depend on one domain with one expiry date. | **Partly** — RDAP gives registrar, dates, nameservers, and the fact of redaction. The contact fields and the renewal setting are dashboard-only. |

### Cloudflare — per-zone settings on the new zone

| # | Item | Kind | Verdict | Verified? |
|---|---|---|---|---|
| X7 | **SSL/TLS mode `Full`** (not Flexible, not Full-strict); **Scrape Shield → Email Address Obfuscation OFF**; **Rocket Loader OFF**; DNS records proxied. All **per-zone**, and a new zone starts at Cloudflare's defaults. | infrastructure config | Verify (founder). Strong indirect evidence says all four are already right. | **Indirectly, and it is good evidence.** All 26 live pages contain **zero** `<script>` tags and zero `/cdn-cgi/l/email-protection` links, and the visible address is the real `help@jwlabs.ai` — obfuscation and Rocket Loader inject exactly those. Responses carry `server: cloudflare` **and** `x-github-request-id` (proxied, reaching the Pages origin), with a 200 rather than a 526 (so not Full-strict) and no redirect loop (so not Flexible). The dashboard toggles themselves were not read. |

### GitHub

| # | Item | Kind | Verdict | Verified? |
|---|---|---|---|---|
| X10 | **Organisation display name is "JW Incorporated"** (`gh api orgs/JW-Incorporated --jq .name`). `blog`, `email`, `location`, `description` are all null. | identity string published to third parties | **MUST change** → "JW Labs LLC". The org **login** `JW-Incorporated` stays — it is in hundreds of correct URLs. This is the display name only, and it is the nonexistent company, on the public profile of the org that owns the repo the website is served from. Same defect class as W7. | **Yes** — GitHub API. |
| X11 | **Repository `homepage` fields**: `foray` → `https://foray-web-seven.vercel.app` (live, 200); `Swift2` → `https://www.longlivets.com`; `jwlabs.dev` → **empty**; `transcript-farm` → empty. | URL a reviewer may check | **DEFER** (founder). No `jwlabs.dev` string, so not strictly in scope — but the public "Website" of the public `foray` repo is an anonymous Vercel preview URL rather than `https://jwlabs.ai/4a/`, and the website repo advertises no site at all. | **Yes** — GitHub API, plus a live fetch of the Vercel URL (which contains no `jwlabs` string). |
| X12 | **Actions variables** (readable): `foray` → `PATH_POLICY_ENFORCE=1`; `Swift2` → `MARJORIE_EMAIL=marjorieswift00@gmail.com`; `transcript-farm`, `jwlabs.dev` → none. **No variable names or values reference either domain.** | infrastructure config | **MUST NOT change** (nothing to change). | **Yes** — `gh api repos/*/actions/variables`. |
| X13 | **Secret names** (values not readable, by design). `foray`, `transcript-farm`, `jwlabs.dev`: **no repository secrets at all**. `Swift2`: `ANTHROPIC_API_KEY`, `DEPENDABOT_ALERTS_PAT`, `FB_PAGE_ID`, `GMAIL_APP_PASSWORD`, `GNEWS_API_KEY`, `IG_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID`, `OPENAI_API_KEY`, `SOCIAL_POSTER_PAT`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TUMBLR_CONSUMER_API_KEY`, `TUMBLR_SECRET_API_KEY`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_API_KEY`, `X_API_KEY_SECRET`. | infrastructure config | **For a human to check.** No name implies a domain. The one worth opening is **`GMAIL_APP_PASSWORD`** — confirm the account behind it is not reached via a `@jwlabs.dev` alias. Also note for `HUMAN-ACTIONS` #19: foray has **zero** secrets, so none of the seven iOS secrets that item asks for have been created. | Names **yes**; values **not readable**. |
| X14 | **Pages configuration**: `jwlabs.dev` repo → `cname: jwlabs.ai`, source `main:/docs`, `status: built`, `https_enforced: false`. `foray` → `cname: null`, `main:/`, serving `jw-incorporated.github.io/foray/`. | infrastructure config | **MUST NOT change** (the CNAME is correct). `https_enforced` is W8. | **Yes** — GitHub API. |
| X15 | **Open issues and PR bodies mentioning the domain**: an org-wide search for `jwlabs.dev` returns **8 results, all closed PRs** (website #1, #2, #4, #6, #7; foray #335, #340, #342). A search for `jwlabs.ai` returns **1**, also closed. **Zero open issues or PRs in any of the four repos mention either domain.** | documentation prose (historical) | **MUST NOT change** — closed PR bodies are the record. Nothing stale is sitting in an open issue waiting to become a future mistake. Re-run before acting: `gh api -X GET search/issues --raw-field q='jwlabs.dev org:JW-Incorporated'`. | **Yes** — GitHub search API, open and closed. |

### Everything else outside the repos

| # | Item | Kind | Verdict | Verified? |
|---|---|---|---|---|
| X8 | **Apple Developer enrollment `DVNC3U5GMU`** — the website URL on file (believed `jwlabs.dev`) and the work-email field (believed `help@jwlabs.dev`). | URL + identity string a reviewer checks | **MUST change** → `https://jwlabs.ai` and `help@jwlabs.ai`, and **both in the same sitting**. Mixing them (a `.ai` site with a `.dev` work email, or the reverse) reproduces the organisation/domain mismatch that caused the rejection. | **No** — requires login. **Founder must do this.** |
| X9 | **App Store Connect / Google Play Console** privacy-policy and support URLs. | URL a store checks | **DEFER** — nothing to fix yet: there is no Apple membership (enrollment rejected, `HUMAN-ACTIONS` #19 open) and no Play listing. The action is to ensure `#42` is *written* with `jwlabs.ai` URLs from the start, which is F1–F3. | **No** — and there is good evidence there is nothing there yet. |
| X16 | **Google Search Console / Play "verified website"** property. | third-party ownership proof | **MUST change** — follows X1. Add `jwlabs.ai` as a property, verify it, and keep the old property until the new one is green. | **No** — requires login. Founder. |
| X17 | **Vercel** — the `foray-web-seven` project (live) and Swift2's projects: custom domains, and any env var holding a URL or contact address. | infrastructure config | Verify. Its served HTML contains no `jwlabs` string. | **Partly** — live HTML fetched and grepped. Project settings need a login. |
| X18 | **Supabase** project `qjdllvqdcgacvujhclny` — Auth redirect allow-list, SMTP sender address, project display name. | infrastructure config | Verify. A `@jwlabs.dev` SMTP sender or a `jwlabs.dev` redirect entry would be invisible from every repository. | **No** — requires login. |
| X19 | **PodcastIndex API registration** | third-party registration | **Nothing to change.** `docs/DECISIONS.md:51`: PodcastIndex was demoted to optional and "the pending API signup is cancelled". No credentials, no registration. | **Yes** — from the decision log; no key exists in any secret list. |
| X20 | **DMCA agent registration** (`dmca.copyright.gov`), filed as Service Provider "JW Labs LLC" — `Swift2/HUMAN-ACTIONS.md:172–185` | third-party registration / legal record | Verify. Whether the filed contact email or website names `jwlabs.dev`. | **No** — requires login. Founder. |
| X21 | **`help@jwlabs.dev` delivery**, during the redirect's life | infrastructure | **MUST NOT break.** Documents already in the wild (X8) name it. | **Partly** — MX and SPF confirm the zone still routes. Actual delivery needs a test message. |

---

## Historical records — MUST NOT change

Named explicitly, because the fix pass will be editing files that contain both
kinds of line:

- **`docs/DECISIONS.md` (foray), all of it.** Every `jwlabs.dev` and
  `dev.jwlabs` mention in it — F7, F8, and the bundle-id entries at 827, 836,
  856, plus the superseding entry the in-flight branch adds — is a dated record
  of what was decided when. The 2026-08-24 `dev.jwlabs.foura` ruling **stays as
  written** even though it has now been superseded twice; that is what the
  "supersedes" wording is for.
- **`HUMAN-ACTIONS.md` #25's illustrative `jwincorporated.com/...` block**
  (`:1647–1650`) — explicitly "left as written only as the record of what was
  proposed".
- **`HUMAN-ACTIONS.md` #15's account of the earlier `com.jwincorporated.foray`
  proposal** (`:914`, `:924`).
- **`docs/apple-enrollment-website.md`'s past-tense analysis** — F9, F10, F12.
  The document's value is that it records what Apple saw and why it failed.
- **Eight closed PR bodies** (X15) and **git history** in all four repos. Not
  editable, not to be edited, and not a defect.
- **Anything asserting `jwlabs.dev` was purchased 2026-08-24** — true, and the
  date matters to the decision trail. Only claims about what the domain *is doing
  now* are stale.

## Intentional `jwlabs.dev` / `JW-Incorporated` strings — not errors

- The **repository is named `jwlabs.dev`**: `github.com/JW-Incorporated/jwlabs.dev`,
  `jw-incorporated.github.io/jwlabs.dev/`, and clone URLs. Correct.
- The **organisation login is `JW-Incorporated`**: 200+ URLs across all four
  repos, plus `FORAY_OWNER_REPO` in transcript-farm and `REPO_URL` in
  `politeness.mjs` (which is transmitted to podcast hosts in three of four
  User-Agents). All correct. Only the org's **display name** is wrong (X10).
- **`raw.githubusercontent.com/JW-Incorporated/foray/main/...`** — the
  transcript-farm queue and identity fetches. Correct.
- **`README.md` (website) probes that target `jwlabs.dev` and expect a 301** —
  `:268`, `:389–391`. Correct, and verified passing today.

## The privacy-policy snapshot chain

The brief asked what has to happen in what order. Checked, and the answer is
better than expected:

**`foray/docs/legal/privacy-policy.md` names neither `jwlabs.dev` nor
`jwlabs.ai`.** Its only URL is `https://jw-incorporated.github.io/foray/`
(`:8`), plus `jw-incorporated.github.io` at `:392` — the Pages origin, which the
domain change does not touch. `docs/legal/data-safety.md` likewise names no
company domain. **So there is nothing in the upstream policy for this migration
to change, and no ordering problem today.**

The chain, recorded for the moment there *is* something to change:

1. `foray/docs/legal/privacy-policy.md` is authoritative.
2. `jwlabs.dev/src/4a-privacy-policy.md` is a **verbatim snapshot** of it,
   `Status: DRAFT` banner and nine `TODO(founder)` notes included, deliberately.
3. `jwlabs.dev/build.mjs` pins `POLICY_COMMIT` and `POLICY_SNAPSHOT`
   (`= "2026-08-24"`) and renders a header on `/4a/privacy/` asserting *which
   commit* the published page is a snapshot of. **The site's build asserts that
   fidelity.**

So the order, whenever the upstream policy gains a domain: **change foray first
and merge it**, then copy the file into `src/4a-privacy-policy.md` **and bump
`POLICY_COMMIT`/`POLICY_SNAPSHOT` in the same PR**. Copying without bumping makes
the published header lie about its own provenance on a legally-operative page.
Bumping without copying does the same. Never edit `src/4a-privacy-policy.md`
directly.

**Related, and this is where the migration's real work in these files is:**
`privacy-policy.md:416` has an open `TODO(founder)` for "a **privacy contact
address**" and `:420` for "where this policy will be **publicly hosted**". Those
are the two holes that `help@jwlabs.ai` and `https://jwlabs.ai/4a/privacy/` now
fill — `HUMAN-ACTIONS` #13 tracks them. Filling them is a **founder** act (a
published policy is binding), not a find-and-replace, and it must then flow
through steps 1–3 above.

## Adjacent findings — not `jwlabs.dev`, but found while looking

Recorded because the brief asked specifically about identity transmitted to third
parties, and because a reader deserves to know these were checked rather than
missed.

1. **The address advertised to podcast hosts at scale is a personal Gmail.**
   `tools/segments/politeness.mjs:41` — `export const CONTACT = "wjduvall@gmail.com"`
   — is interpolated into three of four User-Agents (`UA`, `AUDIO_UA`,
   `CORPUS_UA`) and is therefore sent to every publisher, CDN and enclosure host
   the project touches, plus inherited by the transcript-farm worker. **No
   `jwlabs` string is in there**, so nothing in this migration *requires*
   touching it. But `help@jwlabs.ai` now exists, is verified, and is the
   company's published address — so "the address a publisher who dislikes us
   writes to" being a founder's personal Gmail is now a choice rather than a
   necessity. **Verdict: DEFER, founder ruling.** Not a mechanical change:
   `politeness.mjs` documents (#316) a Buzzsprout edge answering **403 to a
   User-Agent with one extra token and 206 to the canonical one**, which silently
   made 423 transcripts unmeasurable. A User-Agent that changes is a new client
   to a rate limiter. Change it deliberately, once, with the measurement rerun —
   or not at all.
2. **`data/segment-sources.json:8`** records
   `"user_agent": "ForayBot/0.1 (+https://github.com/JW-Incorporated/foray; wjduvall@gmail.com)"`
   as **provenance** — the string used when those feeds were read on 2026-08-16.
   **MUST NOT change**: it is a measurement record, not a live constant.
3. **`data/outbound-identity.json` does not exist on foray's `main`**, although
   `transcript-farm/farm/identity.py:94` prefers it as its identity source. The
   worker falls back to fetching and parsing `politeness.mjs`. Pre-existing, not
   caused by this migration, but it means item 1's address reaches the farm
   through a regex over a JavaScript file.
4. **`sffan15@gmail.com`** still appears twice in foray (and six times in
   Swift2). `politeness.mjs`'s own comment rules it stale as a contact — it is an
   AWS infrastructure login — and folded it onto `CONTACT`. The two remaining
   foray mentions are that explanation. No action.

## Could not verify — and who must check

Nothing here was silently dropped; each row is a thing I tried to check and
could not.

| # | What | Why not | Who must check, and how |
|---|---|---|---|
| X4 | The Email Routing **rule** and **destination** for `help@jwlabs.ai`, and that mail actually arrives | Dashboard-only; DNS proves configuration, not delivery | **Founder.** Cloudflare → jwlabs.ai → Email → Routing rules: confirm `help@` → a verified destination. Then send a real message to `help@jwlabs.ai` from outside and confirm receipt. This is step 13 of the website's own runbook and it is still unticked. |
| X6 | The **registrant organisation** on both domains, and **auto-renew** on `jwlabs.ai` | Cloudflare Registrar redacts registrant data in RDAP/WHOIS | **Founder.** Cloudflare → Domain Registration → Manage Domains → each domain → Contact information (must read **JW Labs LLC**) and Renewal (auto-renew ON). `jwlabs.ai` expires **2028-08-25** and the live site dies with it. |
| X7 | SSL/TLS mode, Scrape Shield, Rocket Loader, proxy status on the **`jwlabs.ai`** zone | Dashboard-only | **Founder.** Evidence says all four are already correct (see X7 above) — this is a confirmation, not a suspicion. SSL/TLS → Overview = `Full`; Scrape Shield → Email Address Obfuscation = off; Speed → Optimization → Rocket Loader = off; DNS → both apex records orange. |
| X8 | The website URL and work email on Apple enrollment **`DVNC3U5GMU`** | Requires an Apple ID login | **Founder.** developer.apple.com → Account → the enrollment/membership details. Change both to `jwlabs.ai` / `help@jwlabs.ai` **together**. Highest-consequence item in this document after F11. |
| X16 | Google Search Console / Play verified-website property | Requires a Google login | **Founder.** Add `jwlabs.ai`, verify (this generates a *new* TXT token — X1), keep `jwlabs.dev` verified until the new one is green. |
| X17 / X18 | Vercel project domains and env vars; Supabase Auth redirect allow-list, SMTP sender, project name | Require logins | **Founder or whoever holds those consoles.** Grep each console's settings for `jwlabs.dev` and for `@jwlabs.dev`. |
| X20 | The DMCA agent filing's contact email and website | Requires a copyright.gov login | **Founder.** `dmca.copyright.gov` → the JW Labs LLC service-provider record. |
| X13 | The **values** of Swift2's 17 secrets | Not readable by design | **Founder.** Only one is plausibly affected: `GMAIL_APP_PASSWORD`. |
| — | Whether the in-flight bundle-id change actually lands | It exists only in an unpushed local branch (`android/bundle-id-jwlabs-ai`, worktree `C:\Users\wjduv\AppData\Local\Temp\wtbid`); foray has zero open PRs | **Whoever acts on this document.** Confirm the PR merged before assuming `ai.jwlabs.foura` is on `main`. If it did not, the bundle id is still `dev.jwlabs.foura` and 52 lines move from IN FLIGHT to MUST change. |

## Every email address in every repo

Included because the brief asked for `@jwlabs` and any other address, and a
tally is the only honest way to show none were missed. Counts are lines on
`origin/main`; podcast-publisher addresses in catalogue data are omitted from the
commentary but were included in the scan.

- **foray** — `help@jwlabs.dev` **×2** (F11, F16; the only `@jwlabs` address in
  any repo), `wjduvall@gmail.com` ×17 (incl. the outbound identity),
  `sffan15@gmail.com` ×2 (documented as stale), `someone@example.org` ×1, and
  ~30 third-party publisher addresses in catalogue/corpus data.
- **transcript-farm** — `wjduvall@gmail.com` ×7, `someone@example.com` ×3,
  `t@example.com` ×1. No company address.
- **jwlabs.dev** — `help@jwlabs.ai` ×122, and **nothing else**.
- **Swift2** — `hello@`, `legal@` ×3, `privacy@` ×2, `submissions@longlivets.com`
  ×4, `sffan15@gmail.com` ×6, `wjduvall@gmail.com` ×3,
  `marjorieswift00@gmail.com` ×1 (+ a typo'd variant), and test fixtures. No
  `@jwlabs` address of any kind.
