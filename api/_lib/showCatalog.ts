/**
 * THE ONE CATALOGUE READER FOR api/ (code-health-2 CH2-24: B1-02, A1-02).
 *
 * Three endpoints resolve a show id against `data/catalog.json` +
 * `data/catalog-breadth.json`: the show page's episode list
 * (`api/shows/[show_id]/episodes.ts`), its search box
 * (`api/episodes/search.ts?show=`) and the show record / show search
 * (`api/shows/search.ts`); the Apple episode fallback maps Apple ids through
 * the same pair (`showIdMap.ts`). Each used to parse the pair itself, with
 * two different admission rules and three different answers for a missing
 * file. They all read it here now, and this reads it through
 * `backend/src/catalog/breadthCatalog.ts`'s `loadCatalogue()`: one parse per
 * warm instance, one repo-root rule, one admission rule.
 *
 * ADMISSION is breadthCatalog's: a curated row with a show_id and a title;
 * a breadth row with an Apple id and a title that is not `in_curated`.
 *
 * AN ALIAS, NOT A SECOND SHOW. An `in_curated` breadth row is not admitted
 * (its curated twin is), but its numeric id is the twin's Apple id, and
 * `showById` answers it with the TWIN: the show_id in the answer is the
 * twin's slug and the feed is the twin's. Before this, the two episode
 * endpoints served those 175 ids from the dropped row's own feed while
 * `/api/shows/search?id=` said `show: null`. Every id that resolved before
 * still resolves.
 *
 * A SHOW WITH NO FEED is a show (`showById` answers it: its page can say
 * what it is) but has no `ShowMeta`: nothing can list or search its
 * episodes. `searchableShows()` leaves it out, and api/shows/search.ts's
 * directory pass drops Apple's row for it, so the SERVER's show search no
 * longer offers a result whose episode list is a 404 (B1-02, 89 rows on
 * 2026-10-07). The listener can still meet 37 of them: the client paints
 * its local index (data/show-index.tsv) first, and its builder,
 * tools/build-show-index.mjs, does not apply this feed_url rule yet (a
 * follow-up outside this card). The alternative, keeping them with an
 * honest "no feed" state, is founder question 5 of
 * docs/roadmap/code-health-2.md; filtering is its default.
 *
 * BUNDLING: the two files reach a deployed function only because
 * vercel.json's `includeFiles` for the api functions glob names them; the
 * BUNDLING NOTE in backend/src/catalog/breadthCatalog.ts says which glob and
 * which test pins it.
 *
 * FILES UNAVAILABLE. Either file missing, unreadable or not JSON is one
 * signal, `CatalogFilesUnavailableError`, thrown by every lookup here: the
 * pair is one artifact, and a deploy that lost half of it is broken, not
 * smaller. Each endpoint answers it once, the same way every time:
 *   - the episode list: 503 `{ error }`, no-store (a deploy gap, not an
 *     unknown show; the client's Try again is the right offer);
 *   - the show-scoped episode search and show search: 200 degraded with the
 *     error, no-store (their one shape on every path);
 *   - the Apple episode fallback: an empty id map, so every hit is dropped
 *     and the answer is honest about nothing it cannot link.
 * A failure is not remembered: the next request reads again.
 */

import {
  loadCatalogue,
  type Catalogue,
  type CatalogueShowEntry,
} from "../../backend/src/catalog/breadthCatalog";

export type { CatalogueShowEntry };

/** What an endpoint needs to read a show's episodes. `showId` is the id the
 *  show is served under: the twin's slug when the caller asked by alias. */
export interface ShowMeta {
  showId: string;
  feedUrl: string;
  title: string | null;
  image: string | null;
}

export const CATALOG_FILES_UNAVAILABLE = "show metadata catalog files are unavailable";

export class CatalogFilesUnavailableError extends Error {
  constructor() {
    super(CATALOG_FILES_UNAVAILABLE);
    this.name = "CatalogFilesUnavailableError";
  }
}

interface Indexes {
  source: Catalogue;
  byId: Map<string, CatalogueShowEntry>;
  appleIds: Map<number, string>;
  searchable: CatalogueShowEntry[];
}

/* Built once beside loadCatalogue()'s own cache and rebuilt only when that
   cache hands back a different catalogue (a test root, or
   FORAY_SKIP_CATALOGUE_CACHE=1): keyed on identity, it cannot go stale. */
let indexes: Indexes | null = null;

function catalogue(): Indexes {
  let source: Catalogue;
  try {
    source = loadCatalogue();
  } catch {
    throw new CatalogFilesUnavailableError();
  }
  if (indexes?.source === source) return indexes;
  const appleIds = new Map<number, string>();
  for (const [appleId, showId] of source.showIdByAppleId) appleIds.set(Number(appleId), showId);
  indexes = {
    source,
    byId: new Map(source.entries.map((s) => [s.show_id, s])),
    appleIds,
    searchable: source.entries.filter((s) => s.feed_url !== null),
  };
  return indexes;
}

/** The merged-catalogue row for `id`, by its own id or by alias; null when
 *  the catalogue does not know it. */
export function showById(id: string): CatalogueShowEntry | null {
  const { byId, source } = catalogue();
  const own = byId.get(id);
  if (own) return own;
  const twin = source.showIdByAppleId.get(id);
  return twin === undefined ? null : byId.get(twin) ?? null;
}

/** What reading `id`'s episodes needs; null for an unknown id and for a show
 *  with no feed. */
export function showMetaById(id: string): ShowMeta | null {
  const show = showById(id);
  if (!show || !show.feed_url) return null;
  return { showId: show.show_id, feedUrl: show.feed_url, title: show.title, image: show.artwork_url };
}

/** Apple collection id -> the show_id its show page resolves (a curated
 *  show's slug, a breadth show's own number). */
export function appleIdToShowId(): ReadonlyMap<number, string> {
  return catalogue().appleIds;
}

/** Every row show search may offer: the catalogue minus the shows with no
 *  feed. Same array per catalogue. */
export function searchableShows(): CatalogueShowEntry[] {
  return catalogue().searchable;
}
