> **MOVED HERE 2026-08-25, and the move is the point.** This document lived in
> the `jwlabs.dev` repository. GitHub Pages serves that repository's branch root,
> so it was publicly readable at `jwlabs.dev/docs/apple-enrollment-website.md` --
> a candid account of an Apple rejection, served by the very site under
> re-review, containing four occurrences of the wrong company name that
> `build.mjs`'s new guard could not see because that file is not built by
> `build.mjs`. Nothing linked to it, but nothing had to: it returned HTTP 200 to
> anyone who guessed the path, and search engines guess paths for a living.
>
> There is no unserved directory in a Pages-from-root repository, so the only fix
> was to move the file out of it.

# What Apple actually requires of this website

This file exists so that nobody has to re-derive it. On **2026-08-24** Apple
rejected JW Labs LLC's Apple Developer Program organization enrollment
(**enrollment ID DVNC3U5GMU**) on the grounds that this website had "minimal
content". This is the checklist the rebuild was built against, the evidence for
each item, and where each item is now satisfied.

Read the source sections first. The distinction between *what Apple states* and
*what we inferred from that statement* is load-bearing: an inference dressed up as
a quotation is exactly the kind of thing this repository refuses to do elsewhere,
and it would be worse here, on a document about a rejection.

---

## 1. The rejection, verbatim

> We're following up with you regarding your enrollment ID DVNC3U5GMU. Upon
> reviewing you details, we see that your website has minimal content.
>
> Your organization's website must be publicly available, functional, and its
> domain name must be associated with your organization. We won't accept links
> to social media webpages or websites that contain minimal content or display a
> message from a domain registrar.

Note what the second paragraph is: it is Apple's published enrollment
requirement, quoted back at us almost word for word (see §2). So the rejection
adds no criteria of its own. Everything actionable is in the published text plus
the one word "minimal", which Apple does not define anywhere we could find.

## 2. Apple's own words

Both quotations were fetched on 2026-08-25 and are verbatim.

From <https://developer.apple.com/support/enrollment/> and
<https://developer.apple.com/programs/enroll/> (identical wording on both):

> Your organization's website must be publicly available and functional, and its
> domain name must be associated with your organization. Links to social media
> webpages or websites that contain minimal content or display a message from a
> domain registrar won't be accepted.

Same pages, on the legal entity:

> To enroll in the Apple Developer Program, your organization must be a legal
> entity so that it can enter into contracts with Apple. We don't accept DBAs,
> fictitious businesses, trade names, or branches. The legal entity name will
> appear as the seller for apps you distribute. Example: *Seller: ABC Company,
> Inc.*

> Our identity verification process for organizations includes several
> components, including but not limited to a D-U-N-S Number and binding
> authority check when enrolling as an organization.

From <https://developer.apple.com/help/account/membership/D-U-N-S/>:

> Your D-U-N-S Number will be used to check the identity and legal entity status
> of your organization as part of our enrollment verification process for joining
> the Apple Developer Program or the Apple Developer Enterprise Program.

Also required, per the enrollment page: **a work email address associated with
your organization's domain name.** That is `help@jwlabs.dev`, and it is the same
domain as this site, which is one of the associations Apple can check without
asking anybody.

## 2a. What the rejection probably actually meant

Apple gave one reason — minimal content — but the requirement it quoted has two
halves, and **the site was failing the second half harder than the first.**

Until 2026-08-25 every page of this site said, in its footer, that it belonged to
**"JW Incorporated"**. There is no such company. The legal entity on the D-U-N-S
record is **JW Labs LLC**. So a reviewer checking whether `jwlabs.dev` was
associated with the applicant organization found the domain naming a *different*
and *nonexistent* company — which is a straightforward failure of "its domain
name must be associated with your organization", regardless of how many pages the
site had.

The name was wrong in one place that matters far more than a footer: the
published privacy policy at `/4a/privacy/` stated that the app "is made and
published by JW Incorporated, which is responsible for the data described above."
That is a declaration of data controllership, on a page both Apple and Google read
as part of an app submission, naming an entity that does not exist. It is fixed
(`build.mjs`, §9 of the publication transform, which draws the name from `ORG` in
`build-md.mjs`).

**The correct framing, and the only one to use anywhere:** JW Labs LLC is the
company. "JW Labs" is the short form of the same company's name, used as the
wordmark. They are not two entities and there is no relationship between them to
describe. Any copy of the form "JW Labs is the studio of *X*" is wrong and should
be deleted on sight — it was invented to bridge a gap that does not exist, and
"studio of a parent company" reads to a reviewer exactly like the DBA / trade-name
arrangement Apple's own text says it does not accept.

## 2b. Two things Apple does NOT require

Both of these were checked deliberately, because a decision was resting on each.

### A physical address on the website: not required

Apple's website requirement, quoted in full in §2, is four things — publicly
available, functional, domain associated with the organization, and not a social
media page / minimal content / registrar message. **It says nothing about a
postal address**, and no other page in Apple's enrollment material asks the
website to carry one.

The organization's address is verified somewhere else entirely, and Apple says so
in as many words. From <https://developer.apple.com/programs/enroll/>:

> Your organization (excluding government entities) must have a D-U-N-S Number to
> verify your organization's identity, legal entity status, and address.

And from <https://developer.apple.com/help/account/membership/D-U-N-S/>:

> The D-U-N-S Number is a unique nine-digit number that identifies business
> entities on a **location-specific** basis.

So the address check runs against the Dun & Bradstreet record, not against
`jwlabs.dev`. **The founder's decision not to publish a postal address does not
put the enrollment at risk**, and it removes a whole class of failure — a
hand-typed address on a web page that does not match the D&B record character for
character is a discrepancy; an absent one is not a discrepancy at all. Publishing
the state of formation (California), which we do, is the part of the location
signal that is safe to publish and impossible to get wrong.

The one caveat, stated so nobody mistakes the scope of this finding: Apple can
ask an organization for notarized business documents during verification (§2), and
those documents will carry the registered address. That is a private exchange with
Apple, not a website requirement.

### Linking to published apps, or naming unpublished ones: not required, and not a known trigger

Apple's website requirement does not mention apps at all. It cannot sensibly
require a link to a published app either: **every organization enrolling for the
first time has zero published apps by definition**, so a requirement to link to
one would make first-time organization enrollment impossible. We found no Apple
text creating such a requirement and no reason to think one exists.

We could not check developer forums for reports of naming unpublished products
being a trigger (see "What we could not verify" below), so treat this as
[derived], not confirmed. The posture the site takes is the conservative one and
should be safe under either reading:

- **Describe the products, state their real status.** `/4a/` says the web app is
  deployed and links to it; it says the iOS and Android shells are built and in no
  store, with no date. `/longlive/` describes a project on its own live domain.
- **Nothing is described in the present tense that does not exist.** No "download
  on the App Store" badge, no fake store link, no "coming soon".
- **There is a working product a reviewer can open right now**, in a browser, with
  no signup: the 4a web app. That is stronger evidence of a real software business
  than a store link would be, and it is the thing the home page leads with.

## 3. The checklist

The requirement decomposes into three things Apple says (publicly available;
functional; domain associated with the organization) and one thing Apple
excludes (minimal content). Items marked **[stated]** come from §2. Items marked
**[derived]** are our reading of what a human reviewer must be able to conclude
in order to tick those boxes.

| # | Requirement | Source | Where it is satisfied now |
|---|---|---|---|
| 1 | Publicly reachable over HTTPS, no login wall, no interstitial, no registrar parking page | [stated] | Apex `jwlabs.dev` serves 200 over TLS. GitHub Pages origin, Cloudflare terminating TLS. No auth anywhere on the site. |
| 2 | Functional: every internal link resolves, nothing 404s, renders on a phone | [stated] | `node build.mjs` writes every page and asserts link shape; a link check walks every `href` and confirms each target exists. Single-column responsive layout, no fixed widths. |
| 3 | The domain names the **legal entity on the D-U-N-S record** | [stated] | `JW Labs LLC` appears in the masthead of **every** page, in the first line of text on the page, and again in every footer. It has exactly one definition in the codebase (`ORG` in `build-md.mjs`) so it cannot drift. |
| 4 | The legal entity name appears exactly as Apple will see it at D&B | [derived] | "JW Labs LLC" throughout — never "JW Labs, LLC.", never "JW Labs Inc". **Confirm the exact D&B string; see §4.1.** |
| 5 | No second, contradictory company name anywhere on the site | [stated, by the DBA exclusion] | "JW Incorporated" is gone from every page. `/about/` states that JW Labs and JW Labs LLC are one company. **One residual, see §5.** |
| 6 | Machine-readable organization/domain association | [derived] | schema.org `Organization` microdata in the site footer: `name` = JW Labs LLC, `alternateName` = JW Labs, `url` = jwlabs.dev, `email` = the contact address. No script tag involved. |
| 7 | Not a placeholder: several real pages of substantive prose, reachable through real navigation | [stated, by exclusion] | 15 pages. Persistent primary nav on every page. ~11,000 words, none of it padding. |
| 8 | The site says what the company **does**, not only that it exists | [derived] | Home page and `/about/` describe the business and what the two products have in common. `/4a/` and `/longlive/` describe each product. |
| 9 | Technical substance that a placeholder could not fake | [derived] | `/engineering/` — five long notes on real, documented problems in the shipped codebase, with measured numbers and named limits. |
| 10 | A working contact route on the organization's own domain, visible without JavaScript | [stated] (work email) + [derived] (visible) | `help@jwlabs.dev`, rendered as a real `mailto:` in static HTML on every page, plus a dedicated `/contact/`. |
| 11 | Legal pages a real company has: privacy and terms | [derived] | `/privacy/` (this website), `/terms/` (website and 4a), `/4a/privacy/` (the app's policy, published from the app's own repository). |
| 12 | Content hosted **on this domain**, not a redirect to social media or another host | [stated] | Nothing on any page is fetched from another origin — the build fails if it is. Off-site URLs exist only as links a reader chooses to follow. |
| 13 | Nothing that reads as under construction | [derived] | No "coming soon", no placeholder copy, no empty section, no dead nav item. Where something is unfinished the page says what is and is not built, in prose, which reads as candour rather than as a stub. |
| 14 | Works with scripts and cookies disabled | [derived] | There is no script on this site at all, and no cookie is set. A locked-down reviewer browser sees exactly what everyone else sees. |
| 15 | Nothing on the site contradicts what Apple can verify | [derived, and the strictest rule here] | No invented employees, addresses, dates, clients, metrics or press. Every number on the engineering pages is traceable to a document in the app's public repository, and is labelled measured / estimated / projected / designed. |

### Item 15 is the one that would be fatal to get wrong

Apple is verifying identity against a Dun & Bradstreet record. The failure mode
of padding a thin site with invented facts is not "the site is still thin"; it is
a discrepancy on a record a reviewer is already looking at, from an applicant who
has already been asked once. The first round of this rejection was caused by
exactly that class of error — a company name nobody had checked. Depth here comes
from the app's own engineering documentation, which is real, or it does not come at
all.

### What we could not verify, and are therefore not claiming

Apple publishes **no** page that defines "minimal content", lists a minimum page
count, or names required page types. We looked. Community reports of this exact
rejection are widely discussed in developer forums, but this session could not
reach them: the web-search budget was exhausted and every general search engine
tried returned a CAPTCHA to an automated fetch. **So the [derived] items above are
our reading of Apple's published wording and of what the verification is evidently
for — not quoted from Apple, and not sourced to forum consensus.** If someone later
reads the forums, correct this file rather than adding a second one.

## 4. Facts only the founder can supply

None of these blocked the rebuild. All of them would strengthen items 3 and 4.

1. **The legal entity name exactly as it appears on the D-U-N-S record.** The
   site says `JW Labs LLC`. If D&B holds `JW LABS LLC`, `JW Labs, L.L.C.` or any
   other exact string, change `ORG` in `build-md.mjs` to match it character for
   character and rebuild. This is the highest-value open item and it costs one
   lookup, because item 4 is what a reviewer checks by eye against a database
   field.
2. **Whether the founders' names may be published.** A named officer is a strong
   association signal and Apple runs a binding-authority check on a named person
   anyway. The site currently says "two founders" without naming them, because
   publishing a person's name is the founder's call, not ours.
3. **Whether a phone number may be published.** Not invented; `/contact/` says
   plainly that email is the only channel.
4. **Whether `jwlabs.dev` is registered to JW Labs LLC** rather than to an
   individual. This is an association test we cannot see the result of from here,
   and it is the one remaining place the domain and the entity could fail to line
   up. Worth a WHOIS check.
5. **The California-specific privacy questions in §6.** Legal review, not facts.

### Settled, and recorded here so they are not reopened

- **Legal entity:** `JW Labs LLC`, a California limited liability company,
  formed **July 26, 2026**. Defined once, in `build-md.mjs` (`ORG`, `ORG_FORM`,
  `ORG_FORMED`). Appears in every footer (name and form) and on `/about/` and
  `/terms/` (name, form and date).
- **No postal address on the site. Ever.** Founder decision, on privacy grounds:
  the registered address is a personal address. §2b establishes that Apple does
  not require one on the website. Do not publish it, do not publish a
  city-and-state-only version, do not add a "write to us for our address" line,
  and above all do not placeholder one.
- **The company's age is not a theme.** The formation date is stated where facts
  belong and is not apologised for, hedged, or used as an explanation for
  anything. Apple sets no minimum company age.

## 5. Remaining rejection risks, honestly

- **The exact D&B name string is unconfirmed.** See §4.1. Highest-value
  unresolved item.
- **The GitHub organisation is named `JW-Incorporated`.** Every link from this
  site to the app's source — the public repository, the deployed web app at
  `jw-incorporated.github.io` — carries that string in the URL, so a reviewer who
  follows one sees a name that is not the company's. It is not fixable from this
  repository: renaming the organisation breaks every git remote and every existing
  link, and the site does not get to choose GitHub's URLs. Flagged to the founder
  separately. The site does not draw attention to it and does not explain it
  away; the links are simply what they are.
- **The domain registrant is unverified.** The domain and the company name now
  match, which is the main thing. The one association test we cannot see the
  result of from here is WHOIS: if `jwlabs.dev` is registered to an individual
  rather than to JW Labs LLC, that is a visible mismatch on a record Apple can
  pull. §4.4.
- **`/longlive/` is the thinnest page on the site**, because longlive has its own
  domain and this repository holds few verified facts about it. It is now several
  paragraphs drawn from what longlivets.com itself publishes, rather than one
  sentence, but it remains the page a reviewer could point at. Not fixable from
  here without facts from the longlive side. Note also that longlivets.com does
  not name a company anywhere; if that domain is also on the D-U-N-S record's
  radar, it has the same association problem this site just fixed.
- **The site's own source is served.** `https://jwlabs.dev/src/...` returns the
  Markdown behind the pages, and `src/4a-privacy-policy.md` still carries the
  upstream `Status: DRAFT` banner. See the README section on that trade. It is a
  disclosure, not a contradiction, but a reviewer who found it could read it as
  an unfinished site.
- **Nothing is in any app store yet.** The site says so. That is a fact about the
  company, not a defect in the website, and hiding it would violate item 15.

## 6. Deliberate silences in the legal pages

`/terms/` and `/privacy/` are boilerplate written in-house, authorised by the
founder, and reviewed by no lawyer — which both pages say. Three points are left
silent on purpose, following the pattern already established by the 4a privacy
policy, which states outright that it declares no retention period because no
retention job exists. Silence with a recorded reason is an omission; a sentence we
cannot support is a false statement in a document a store reviewer reads.

1. **No claim of CCPA/CPRA compliance.** JW Labs LLC is a California company, so
   the question is live and conspicuous. But most CCPA/CPRA obligations turn on
   revenue and data-volume thresholds that nobody has assessed for a company a
   month old, and "we comply with the CCPA" is a statement of fact about a review
   that has not happened. `/privacy/` therefore describes plainly what the site
   does and does not collect, names California as the company's home, gives a
   working address for any privacy request, and stops there. **Founder/legal
   question:** whether a California-resident rights section should be added, and
   on what basis.
2. **No GDPR/UK-GDPR position.** Unchanged from the 4a policy's standing open
   item: US-only listing versus accepting GDPR obligations from day one is an
   unresolved founder decision, and it changes what a privacy notice must promise.
3. **No data-retention period for the 4a event rows.** Inherited verbatim from the
   app's own policy, which explains why: no retention job has been built, and a
   stated period we do not enforce would be a false declaration.

`/terms/` does name **California** as governing law and venue, which is ordinary
boilerplate for a California LLC and is within what the founder authorised.

## 7. Re-verify after every deploy

The two Cloudflare settings described in the README are invisible from this
repository and have rewritten this site's HTML before. Run these against the
**served** pages, not the built ones:

```
for p in / /about/ /contact/ /engineering/ /engineering/segment-anchoring/ \
         /engineering/transcripts/ /engineering/curation/ \
         /engineering/measurement/ /engineering/privacy-by-construction/ \
         /terms/ /privacy/ /4a/ /4a/privacy/ /4a/support/ /longlive/; do
  printf '%s ' "$p"
  curl -sS "https://jwlabs.dev$p" |
    awk '{n+=gsub(/<script/,"&"); c+=gsub(/cdn-cgi/,"&")} END {print "scripts="n" cdn-cgi="c}'
done

curl -sS https://jwlabs.dev/ | grep -o 'mailto:[^"]*'      # must be the real address
curl -sS https://jwlabs.dev/ | grep -c 'JW Incorporated'   # must be 0
```

`scripts=0 cdn-cgi=0` on every line, a real `mailto:`, and zero occurrences of
the wrong company name. Anything else means Email Address Obfuscation or Rocket
Loader came back on in the Cloudflare zone, or that a page regressed.
