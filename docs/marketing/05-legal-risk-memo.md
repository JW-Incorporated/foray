# Legal / Compliance Risk-Scoping Memo — CommutePilot

> **Name change since this memo — 2026-08-21.** This memo was researched
> against a working name, "CommutePilot," which is not the shipped
> product: the founder chose **4a** (`foray` now names only the
> stitched-audio unit — see `06-naming-study.md`, `docs/DECISIONS.md`).
> Read every "CommutePilot" below as "4a." This memo also cites
> `01_PROMPT.md` and `05_CORNER_CASES.md` — files foreign to this corpus
> that are not present in this repo; treat those citations as pointing
> to an earlier planning document set this memo was written against, not
> to anything in `docs/`. **Applicability, item by item:** the
> RSS-client legal baseline (§1), App Store guideline analysis (§App
> Store), and third-party-AI-disclosure requirement (§5.1.2) are
> name-independent and still apply as-is to 4a. **One section does NOT
> transfer and must be redone, not just renamed:** §"Name clearance" —
> its trademark-adjacency finding (no registered mark for "CommutePilot,"
> low collision risk with "Copilot") clears a name 4a doesn't use. It is
> not a trademark clearance for "4a." Per `06-naming-study.md`'s
> 2026-09-02 closing note, "4a" has never been run through a clearance
> search and has a plausible unaddressed collision with Google's "Pixel
> 4a" line — that is open work, not covered by this memo's now-moot
> CommutePilot clearance.

**Author:** legal/compliance desk (non-lawyer, risk-scoping only) · **Date:** 2026-07-07

> This is a risk-scoping memo, not legal advice. I'm not a lawyer and this isn't a substitute for one. It's meant to flag where CommutePilot's current design sits relative to known precedent, App Store rules, and applicable statutes, with sources, so a solo developer can prioritize. Treat every "LOW" below as "low given current scope," not "cleared forever" — re-check at monetization.

Scope reminder (per `01_PROMPT.md` constraint 3 and `05_CORNER_CASES.md` item 36): CommutePilot streams/downloads episode audio directly from publisher enclosure URLs, never rehosts/proxies/transforms/ad-strips, counts downloads via original URLs, and only hosts its own generated TTS intros. Anthropic-API-generated summaries/why-lines are built from episode metadata now, transcripts later.

---

## 1. The podcast-client baseline

**Risk: LOW** — the architecture matches the established safe pattern for RSS podcast clients.

The podcast ecosystem runs on what industry press calls an "unwritten contract": publishing an open RSS feed is implicit permission for any client app to index it and link listeners to the enclosure, the same way publishing a website invites search-engine crawling. Apps that only *link to and play* the original audio (Overcast, Pocket Casts, AntennaPod) have operated for over a decade without publisher litigation. The apps that got burned did something structurally different from what CommutePilot does:

- **Stitcher** cached and re-encoded audio on its own servers — publishers pushed back until it stopped.
- **Luminary** ran a proxy server between listeners and publisher audio at launch — shows pulled from the platform, contributing to a well-documented rocky launch.
- **PodcastAdBlock** (active as of 2026) uses AI to strip ads and sponsor reads, then re-serves the cleaned audio from its own feed URLs — estimated at ~$944K in diverted ad revenue industry-wide in under six months, and the article covering it frames it explicitly as the kind of behavior that breaks the open ecosystem's trust. No confirmed lawsuit yet, but it's the live example of what draws heat.

CommutePilot's constraints (stream/download from the original enclosure URL, never rehost/proxy/transform, never strip ads, count downloads via the original URL) put it firmly in the "search-engine-like client" bucket, not the Stitcher/Luminary/PodcastAdBlock bucket. The main risk isn't the current design — it's *scope creep*: a future feature request like "auto-skip the sponsor read" would cross from client into ad-stripper territory and should be treated as a new legal review trigger, not a routine feature (see checklist).

Sources:
- [The unwritten contract between podcast publishers and apps — Podnews](https://podnews.net/article/the-unwritten-contract)
- [PodcastAdBlock strips ads and sells shows — Podnews](https://podnews.net/article/podcastadblock-strips-ads-and-sells-shows)
- [PodcastAdBlock Sparks Copyright Concerns — podcastvideos.com](https://www.podcastvideos.com/articles/podcastadblock-ai-ad-free-copyright-concerns/)

---

## 2. App Store review

**Risk: LOW-MEDIUM** — mostly straightforward, with two specific friction points worth pre-empting.

**5.2.2 (third-party content authorization).** Apple requires that content displayed/accessed from a third-party service be "specifically permitted... under the service's terms of use," with authorization provided on request. Open RSS feeds don't come with a formal ToS granting this explicitly — the "unwritten contract" norm above is an industry convention, not a signed license. Every mainstream podcast client relies on the same informal footing, so this is a well-trodden path, but if a reviewer questions it, be ready to explain the open-podcasting model in App Review notes rather than assume it's self-evident.

**5.2.3 (audio/video downloading).** This section prohibits apps that "save, convert, or download media from third-party sources... without explicit authorization" — written with YouTube/Spotify rippers in mind. CommutePilot's offline-download feature (`05_CORNER_CASES.md` requires offline-first playback) downloads directly from a publicly published enclosure URL, which is categorically different from ripping a locked streaming service, and Apple Podcasts itself offers the identical download-for-offline behavior. Still, since this guideline is the single most likely rejection vector for a podcast client, **write explicit App Review notes** stating that the app downloads podcast episodes from their own publicly published RSS enclosure URLs — the same mechanism every podcast app uses — before submitting.

**5.1.2 / third-party AI disclosure (new as of late 2025).** Apple now requires apps to disclose when personal data is shared with third-party AI (explicitly named, e.g., "Anthropic") and to get explicit user permission before the first transmission. CommutePilot's backend sends episode metadata and (later) listening-history-derived context to the Anthropic API to build curation and why-lines. Even though the call originates server-side rather than from the device, the data ultimately reaches a third-party AI, so the safer reading is that disclosure + consent UI + a privacy-label entry are required. Build this in now — it's cheap pre-launch, expensive to retrofit into an already-submitted app.

**4.1/4.3 (copycat / spam).** Low risk — CommutePilot's curation + TTS-intro feature set is meaningfully differentiated from stock podcast players, so it shouldn't trip "indistinguishable from what's already available."

**1.2 (User Generated Content) — LOW today, SUBMISSION-BLOCKING at phase 2.** `docs/curation/generation-architecture.md` §1.3 already flags this: today (phase 1) every generated Foray is prompted by a founder and reviewed before it reaches the shared catalogue, so 4a is not hosting UGC in Apple's sense and Guideline 1.2 does not bite. **Phase 2 — any user's prompt reaching the shared catalogue — changes that.** The moment a stranger's prompt can produce content other users hear, 4a becomes a UGC host and Guideline 1.2 requires all four of:
  1. Content filtering (a moderation/classification step before a stranger-prompted Foray is playable to anyone else).
  2. A mechanism for a user to report objectionable content.
  3. A way to block abusive users.
  4. Published developer contact information (a support address/page, not just a store listing).

None of the four exist in the current build — this is a known, named gap, not a discovered one, and it is a submission-blocking rejection risk the moment a phase-2 build reaches App Review. It is a phase-2 precondition, not a phase-1 action item: **do not build the moderation system now**, but do not schedule phase 2 without it either. Track it explicitly in `HUMAN-ACTIONS.md` (item added the day phase 2 is scheduled) rather than letting it live only in the engineering doc.

Source: [App Review Guidelines §1.2 (User Generated Content) — Apple Developer](https://developer.apple.com/app-store/review/guidelines/#user-generated-content)

**2026 rejection trends worth noting generically:** the fastest-growing rejection category is privacy (missing AI-data-sharing consent screens, missing `PrivacyInfo.xcprivacy` manifests for bundled third-party SDKs like Supabase's), plus incomplete/placeholder-content submissions. Both are process items, not architecture risks.

**CarPlay entitlement.** Per the brief, apply early — Apple assigns the entitlement account-wide, locks the app to one CarPlay category (audio fits), wants to see a substantive working iPhone app before granting it, and review timelines run from days to several weeks with no published SLA. None of this blocks other milestones; just start the request once there's a real app to point to.

Sources:
- [App Review Guidelines — Apple Developer](https://developer.apple.com/app-store/review/guidelines/)
- [Apple's Guideline 5.1.2(i): The AI Data-Sharing Rule — DEV Community](https://dev.to/arshtechpro/apples-guideline-512i-the-ai-data-sharing-rule-that-will-impact-every-ios-developer-1b0p)
- [New App Store Rules Target Personal Data Sharing With AI — AppleMagazine](https://applemagazine.com/new-app-store-rules-personal-data-ai/)
- [Requesting CarPlay Entitlements — Apple Developer Documentation](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements)
- [Why Apps Get Rejected in 2026 — OpenSpace Services](https://www.openspaceservices.com/blog/mobile-app-development/apple-app-store-rejection-guide-2026-the-15-most-common-reasons-and-how-to-fix-each)

---

## 3. AI-generated derivative text/audio (summaries, why-lines, TTS intros)

**Risk: LOW-MEDIUM today, rises if scope changes** — the personalized/short/private nature of the output is the thing keeping this low; each of those three properties is a lever that, if relaxed later, raises risk.

The 2024-2026 case law gives an actual dividing line, not just vibes. In *Advance Local Media v. Cohere* (S.D.N.Y., 2025), the court held that "substitutive summaries" — non-verbatim outputs that nonetheless mirror the expressive structure and storytelling choices of the original — can plausibly infringe, denying Cohere's motion to dismiss. Contrast that with *CIR v. Microsoft* (April 2025), where a judge dismissed claims that Copilot's bullet-point "abridgments" of news articles infringed, because the reorganized, skeletal summaries weren't substantially similar to the originals. The U.S. Copyright Office's own report on RAG-style summarization says the use is "less likely to be transformative where the purpose is to generate outputs that summarize or provide abridged versions" of the source.

Read together, the risk axis is: **does the output substitute for the original** (a full recap someone could use instead of reading the show notes or listening) **or is it transformative editorial framing** (short, personalized, referencing the listener's own history, oriented around "why this, why now" rather than "what's in it")? CommutePilot's why-lines and TTS intros are designed to be the latter by spec (`01_PROMPT.md`: "must reference *my* context, not generic praise"), which is the right instinct legally as well as for product quality — keep it that way.

There's no bright-line word count in fair-use law — the "10%" and "300-word" rules people cite are myths, not statute — but practical risk-reducing habits used across the industry hold up:

- **Cap generated summary length** (e.g., short spoken intros, short on-card why-lines) — already implied by the "short generated audio intro" spec; enforce it in the prompt template, not just by convention.
- **No verbatim quoting from show notes beyond a short phrase** (a handful of words) — paraphrase, don't lift sentences. A quoted line is a reproduction of the publisher's copyrighted description text, not just the underlying facts.
- **Always frame around the listener's specific context**, not a generic recap of the episode — this is both the product's soul (per the brief) and the thing that keeps output on the "transformative" side of the Cohere/CIR line.
- **Attribute** show and episode title/publisher in every intro.
- **Don't build a public, browsable archive** of generated summaries — single-user-private consumption is a meaningfully different (lower-risk) posture than a public content surface, and this product is single-user by design today. Revisit hard if a future feature makes summaries visible outside the account that generated them (shared links, social features, marketing use of blurbs).
- Where Tier-2 transcript-based enrichment lands later, apply the same rules to transcript-derived text — don't let internal ranking text leak out as user-facing copy without going through the same length/paraphrase discipline.

Sources:
- [Court Rules AI News Summaries May Infringe Copyright — Copyright Lately](https://copyrightlately.com/court-rules-ai-news-summaries-may-infringe-copyright/)
- [AI Copyright Lawsuit Developments in 2025 — Copyright Alliance](https://copyrightalliance.org/ai-copyright-lawsuit-developments-2025/)
- [The Missing Fair Use Argument in the Copyright Battle Over AI Summaries — Tech Policy Press](https://www.techpolicy.press/the-missing-fair-use-argument-in-the-copyright-battle-over-ai-summaries/)
- [Generative AI and Copyright Law, Part Two: Fair Use and Infringement Risks — Mayer Brown](https://www.mayerbrown.com/en/insights/podcasts/2025/05/generative-ai-and-copyright-law-part-two-fair-use-and-infringement-risks)
- [How to use AI in Podcasting: The Exciting Opportunity — and the Legal Minefield — Podnews](https://podnews.net/article/how-to-use-ai-in-podcasting-legal)
- [Fair Use — 17 U.S. Code § 107 — Cornell LII](https://www.law.cornell.edu/uscode/text/17/107)

---

## 4. Trademark / name

**Risk: LOW** — informal search turned up no direct conflict; do a real (free) knockout search before spending money on branding.

An informal web/USPTO-adjacent search found no registered or pending U.S. trademark for "CommutePilot," and no existing App Store listing under that name. The nearby-name risk is the "Copilot" family: Microsoft holds a registered COPILOT mark (Reg. #6256123, filed 2020) in AI/software classes, and the term has become heavily contested — dozens of "X Copilot" filings exist across AI/software/navigation categories, Microsoft itself has both defended and, oddly, abandoned some related applications, and the space is generally litigious around that specific word. "CommutePilot" uses "Pilot," not "Copilot" — a materially different mark — and there's also an existing "Copilot Money" personal-finance app in a different category, which lowers direct-confusion odds further. This reads as ordinary background noise in a crowded naming space, not a specific threat to this name.

Recommendation: don't over-invest in this pre-launch, but before committing real money to logo/branding assets, run an actual USPTO TESS knockout search (free, ~10 minutes) for "CommutePilot" and close variants in classes 9 (software) and 42 (SaaS), and repeat the App Store name-search check right before submission since the landscape shifts over a multi-month build.

Sources:
- [MICROSOFT COPILOT — Trademark Registration — uspto.report](https://uspto.report/TM/98161972)
- [Who Owns the Name and Trademark CoPilot? — Brighter Naming](https://www.brighternaming.com/who-owns-the-name-and-trademark-copilot/)
- [USPTO Trademark Search](https://www.uspto.gov/trademarks/search)

---

## 5. Privacy

**Risk: LOW now, specific action items before multi-user monetization.**

**App Store privacy nutrition label.** Expect to disclose: Usage Data (play/skip/finish/voice-command events, tied to `user_id` per the schema requirement), Identifiers, and — once Tier-2 voice/transcript paths ship — User Content/Audio Data. Combine this with the 5.1.2 third-party-AI disclosure from Section 2: name Anthropic explicitly in the consent copy and privacy label, not just a generic "AI" mention.

**Listening-history sensitivity.** Apple's own "Sensitive Info" category (race, sexual orientation, biometrics, political belief) doesn't literally include podcast history, so it likely doesn't force the strictest label tier. But treat it as sensitive in practice anyway: a full listening history can reveal political leanings, health interests, religious views, etc., the same way browsing/search history can. The practical mitigation is simple and already implied by the product's single-user, non-ad-funded design: don't sell or share listening data with third parties or ad networks, and use it only for first-party curation. That posture alone keeps the data out of the "sale/share" definitions that trigger most privacy-law obligations below.

**CCPA.** Applicability triggers at *any one* of: >$26.625M annual gross revenue (2026 inflation-adjusted figure), ≥100,000 CA consumers/devices/households annually, or ≥50% of revenue from selling/sharing personal information. A single-user app is nowhere close on any axis, and even an early multi-user monetization launch (hundreds to low thousands of users) stays far under the 100K threshold. Re-check this at scale — 100K CA MAU is a reasonable milestone to re-run the numbers, not a day-one concern.

**GDPR.** Unlike CCPA, GDPR has no size/revenue threshold — it applies based on whether you target or monitor people in the EU, regardless of company size, so "solo developer" doesn't exempt you. Because the App Store is global by default, an EU resident could technically download the app even during the single-user phase, though real-world exposure is close to zero while it's genuinely one person's account. Two honest options going forward: geo-restrict the App Store listing to the US to sidestep the question entirely until deliberately ready to serve EU users, or accept the low-cost basics (a real privacy policy, a data export/delete path) as a standing practice regardless of geography — the latter is good hygiene either way and costs little to build now.

**Podcast Index / iTunes Search API terms of service.** Both are usable as designed: Podcast Index requires ToS acceptance via API key registration and sets its own rate limits at its discretion; the iTunes Search API is capped around ~20 calls/minute. Neither imposes compliance risk beyond what the feed-polling architecture (`docs/adr/0001-feed-polling-strategy.md`) already has to handle for politeness — per-host budgets, backoff, honest User-Agent with contact info (also required by `05_CORNER_CASES.md` item 8). Make sure the Podcast Index ToS is actually accepted (their `tos_accept` flow) before the first production call, not discovered as a gap later.

Sources:
- [App Privacy Details — Apple Developer](https://developer.apple.com/app-store/app-privacy-details/)
- [CCPA Applicability - 2026 Guide — Clym](https://www.clym.io/blog/ccpa-applicability-guide)
- [Territorial scope of the GDPR from a US perspective — IAPP](https://iapp.org/news/a/territorial-scope-of-the-gdpr-from-a-us-perspective)
- [Does the GDPR apply to companies outside of the EU? — GDPR.eu](https://gdpr.eu/companies-outside-of-europe/)
- [Podcastindex.org — Terms of Service](https://github.com/Podcastindex-org/legal/blob/main/TermsOfService.md)
- [iTunes Search API: Overview — Apple Developer](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html)

---

## Checklist

### Do now (cheap, and cheaper now than retrofitted later)
- [ ] Treat "never rehost/proxy/transform/ad-strip; count downloads via original URL" as a hard invariant in code review, not just a design intent — this is the single biggest lever on Section 1's risk rating.
- [ ] Build length caps and a "no verbatim quoting beyond a short phrase" rule directly into the summary/why-line/TTS-intro prompt templates now, while the Tier-1 classification prompts are still being written.
- [ ] Run a free USPTO TESS knockout search for "CommutePilot" in classes 9/42 before spending money on logo/branding.
- [ ] Draft a one-paragraph privacy policy stub — needed before App Store submission anyway, and forces clarity now on what data is collected and why.
- [ ] Confirm Podcast Index API ToS acceptance and an honest, contact-info-bearing User-Agent string before the first production fetch.

### Do before App Store submission
- [ ] Write App Review notes explicitly explaining the RSS/enclosure download model (pre-empt a 5.2.3 misread).
- [ ] Build the 5.1.2 third-party-AI consent screen naming Anthropic explicitly, shown before the first data transmission, and reflect it in the privacy nutrition label.
- [ ] Complete the privacy nutrition label for Usage Data, Identifiers, and (once voice/transcript paths ship) Audio/User Content.
- [ ] Add a `PrivacyInfo.xcprivacy` manifest covering the Supabase SDK and any other bundled third-party library.
- [ ] Decide and document the geo-availability choice (US-only launch vs. accepting GDPR obligations day one).
- [ ] Apply for the CarPlay audio entitlement once the iPhone app is substantive (per brief — don't block other milestones on it).
- [ ] Re-run the App Store name/icon collision check immediately before submission (names and the competitive landscape drift over a multi-month build).

### Do before phase 2 is scheduled (any-user prompting)
- [ ] Build the four Guideline 1.2 UGC-moderation requirements before any stranger-prompted Foray can reach another user: content filtering, a report-objectionable-content mechanism, a user-blocking mechanism, and published developer contact info (see Section 2). Confirm the corresponding `HUMAN-ACTIONS.md` item is filed and open before phase 2 work is scheduled, not after.

### Do at monetization (multi-user, revenue)
- [ ] Get a real (paid, attorney-assisted) trademark clearance search before formally registering "CommutePilot" as a mark.
- [ ] Get an actual lawyer to review the privacy policy and terms of service, especially data export/delete flows if EU users are in scope.
- [ ] Re-check CCPA thresholds annually against real user/revenue numbers (100K CA consumers/devices, ~$26.6M revenue, or 50%+ revenue from data sales).
- [ ] Revisit Section 3's risk rating the moment generated summaries/why-lines become visible outside the account that generated them (shared links, social features, marketing use of blurbs) — the fair-use posture changes materially once output leaves single-user private use.
- [ ] Treat any ad-adjacent feature request (even "skip the sponsor read," not full stripping) as a new legal-review trigger, not a routine feature — this is the constraint most likely to erode quietly through good intentions.
