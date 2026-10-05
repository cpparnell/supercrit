// Year and director never change, so a hit is kept for good; a miss is retried daily.
const CRITERION_TTL = 3650 * DAY_MS;
const CRITERION_MISS_TTL = DAY_MS;
const MAX_ATTEMPTS = 4;
const criterionLimit = limiter(4);
let seenCards = new WeakMap(); // card -> the film id it was scanned for
let nearCards = new WeakSet(); // within rootMargin of the viewport right now
const busyCards = new WeakSet(); // queued or in flight

class TransientError extends Error {}

// Everything Criterion-specific (selectors, URLs, the API) is in lib/site.js.
const SEL = SELECTORS;

// Criterion's own record of a film, keyed by its media id. Bump the version to invalidate.
const ccKey = (id) => `cc5:${id}`;

// Criterion's API titles some films differently from the catalog and the cards: an episode is just
// "Episode 1" where its card says "Joséphine en tournée: Episode 1", and there are smaller drifts
// ("The IX Olympiad in Amsterdam" for "…at Amsterdam"). The title the page prints is the one the
// catalog and the snapshot go by, so it wins over the API's; the API is kept for directors and year.
const withTitle = (meta, title) => (meta && title ? { ...meta, title } : meta);

// A film already known from the shared snapshot (which has the catalog's title) or the API,
// without any network.
function cachedMeta(id, printedTitle) {
  return cachePeek(SNAPSHOT_KEY)?.v?.films?.[id] || withTitle(cachePeek(ccKey(id))?.v, printedTitle) || null;
}

// Snapshot first (refreshed nightly for everyone), then this install's own live lookups.
function cachedFilm(key) {
  const shared = snapshotByKey(cachePeek(SNAPSHOT_KEY)?.v).get(key);
  return shared ? { v: shared, stale: false } : cachePeek(key);
}

async function criterionMetaFor(id, wanted, printedTitle) {
  const key = ccKey(id);
  const cached = await cacheGet(key);
  const known = cachedMeta(id, printedTitle);
  if (known) return known;
  if (cached && !cached.stale) return cached.v;

  const res = await politeFetch(criterionLimit, mediaUrl(id), {}, wanted);
  if (!res.ok) throw new TransientError(`criterion-http-${res.status}`);
  const meta = parseMedia(await res.json());
  await cacheSet(key, meta, meta ? CRITERION_TTL : CRITERION_MISS_TTL);
  return withTitle(meta, printedTitle);
}

// The film's id and the element the badge is drawn over, or null if the card isn't a film's
// (collections and supplements share the card) or lacks either.
function cardParts(card) {
  const link = card.querySelector(SEL.cardLink);
  const id = link && criterionId(link.href);
  const container = card.querySelector(SEL.cardImage);
  return id && container ? { id, container } : null;
}

// Title and year as the card prints them. Enough for the cache key (lbKey ignores directors), so a
// film looked up before paints without asking Criterion for anything; a live lookup needs the API.
function cardMeta(card) {
  const title = card.querySelector(SEL.cardTitle)?.textContent.trim();
  const year = card.querySelector(SEL.cardYear)?.textContent.trim();
  return title && /^(18|19|20)\d\d$/.test(year) ? { title, year: +year } : null;
}

const printedTitle = (card) => card.querySelector(SEL.cardTitle)?.textContent.trim() || null;
const knownMeta = (card, id) => cachedMeta(id, printedTitle(card)) || cardMeta(card);

// The snapshot and this install's own results are mirrored here too, so a film already known needs
// no message at all. That matters more than one round trip: the MV3 worker sleeps after 30s idle,
// so the first card of a visit would otherwise pay its cold start. Stale entries still go through
// the worker, which serves the old value and refreshes behind it.
async function lookup(film) {
  const local = cachedFilm(lbKey(film));
  if (local && !local.stale) return local.v;
  const res = await chrome.runtime.sendMessage({ type: "lookup", film });
  if (!res || res.error) throw new TransientError(`letterboxd-error: ${res?.error}`);
  return res.film;
}

const formatCount = (n) => new Intl.NumberFormat().format(n);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(paths) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}

const EYE =
  '<path d="M0.8 5C2 2.9 3.4 1.9 5 1.9S8 2.9 9.2 5C8 7.1 6.6 8.1 5 8.1S2 7.1 0.8 5Z" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
  '<circle cx="5" cy="5" r="1.5" fill="currentColor"/>';
const CLOCK =
  '<circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
  '<path d="M5 2.7V5l1.6 1.1" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>';
const DICE =
  '<rect x="0.75" y="0.75" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
  '<circle cx="3" cy="3" r="0.9" fill="currentColor"/>' +
  '<circle cx="7" cy="3" r="0.9" fill="currentColor"/>' +
  '<circle cx="5" cy="5" r="0.9" fill="currentColor"/>' +
  '<circle cx="3" cy="7" r="0.9" fill="currentColor"/>' +
  '<circle cx="7" cy="7" r="0.9" fill="currentColor"/>';

// Marks a rating that belongs to the whole series ("Carlos" for "Carlos: Part 2"): a stacked
// icon that widens to spell out "Series Rating" on hover.
function seriesTag() {
  const tag = el("span", "supercrit-series");
  tag.append(
    icon(
      '<rect x="3" y="0.75" width="6.25" height="6.25" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
        '<rect x="0.75" y="3" width="6.25" height="6.25" rx="1" fill="currentColor"/>'
    ),
    el("span", "supercrit-series-label", "Series Rating")
  );
  return tag;
}

// Which features are on (lib/settings.js), from the popup. Read at start and on every change.
let settings = DEFAULT_SETTINGS;

// The user's own history with this film (see lib/user.js), or null if no username is set or marks
// are turned off. Data synced for a previous username is ignored until the new one's sync lands.
function markFor(film) {
  if (!settings.marks) return null;
  const user = cachePeek(USER_KEY)?.v;
  return user?.username === cachePeek(USERNAME_KEY)?.v ? userMark(film, user) : null;
}

// The user's own score sits beside the consensus, in the same notation, since the whole point is
// reading one against the other. Half-stars are exact at one decimal place ("3.5", "4.0").
function markTag(mark) {
  const tag = el("span", mark.watched ? "supercrit-mark supercrit-mark--watched" : "supercrit-mark supercrit-mark--watchlist");
  tag.append(icon(mark.watched ? EYE : CLOCK));
  if (mark.rating) tag.append(el("span", "supercrit-mark-rating", mark.rating.toFixed(1)));
  return tag;
}

const markTitle = (mark) =>
  mark.watched ? `You watched this${mark.rating ? ` · ${starText(mark.rating)}` : ""}` : "In your watchlist";

// Replaces any existing badge, so a score painted from a stale cache entry gets updated in place.
// Letterboxd withholds the average for films with few ratings; a dash tells that apart from a miss.
function renderBadge(container, film) {
  if (!settings.ratings) return;
  const badge = el("div", "supercrit-badge");
  if (film.rating == null) {
    badge.classList.add("supercrit-badge--unrated");
    badge.title = "Letterboxd: not enough ratings yet";
    badge.append(el("span", "supercrit-star", "★"), el("span", null, "–"));
  } else {
    badge.title = `Letterboxd ${film.series ? "series rating " : ""}${film.rating.toFixed(2)} · ${formatCount(film.ratingCount)} ratings`;
    badge.append(el("span", "supercrit-star", "★"), el("span", null, film.rating.toFixed(1)));
  }
  if (film.series) {
    badge.classList.add("supercrit-badge--series");
    badge.append(seriesTag());
  }
  const mark = markFor(film);
  if (mark) {
    badge.append(markTag(mark));
    badge.title += ` · ${markTitle(mark)}`;
  }
  // The badge is positioned against the artwork, whatever the site's own CSS does with it.
  container.classList.add("supercrit-anchor");
  const existing = container.querySelector(".supercrit-badge");
  if (existing) existing.replaceWith(badge);
  else container.appendChild(badge);
}

// ---------- Film page ----------
// The site navigates client-side, so a film page can arrive without a page load and its header can
// be re-rendered under us. syncDetail runs on every DOM change: it drops the line when the page
// changes, redraws it when the header was replaced, and looks up each film page once per visit.
let detail = null; // { path, film }, kept so the line can be redrawn, e.g. when the user's data syncs
let detailTried = null; // the path last looked up, so a miss isn't retried on every mutation

const detailAnchor = () => document.querySelector(SEL.detailMeta) || document.querySelector(SEL.detailTitle);

function renderDetail() {
  const anchor = detailAnchor();
  if (!detail || !anchor || !settings.ratings) return;
  const { film } = detail;
  const link = el("a", "supercrit-detail");
  const href = filmUrl(film.url);
  if (href) link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  if (film.rating == null) {
    link.append(el("span", "supercrit-label", "Letterboxd: not enough ratings yet"));
  } else {
    link.append(
      el("span", "supercrit-star", "★"),
      el("span", "supercrit-score", film.rating.toFixed(2)),
      ...(film.series ? [seriesTag()] : []),
      el("span", "supercrit-label", "Letterboxd"),
      el("span", "supercrit-muted", `${formatCount(film.ratingCount)} ratings`)
    );
  }
  const mark = markFor(film);
  if (mark) {
    const you = el("span", `supercrit-you ${mark.watched ? "supercrit-you--watched" : "supercrit-you--watchlist"}`);
    you.append(icon(mark.watched ? EYE : CLOCK), el("span", null, mark.watched ? "Watched" : "In your watchlist"));
    if (mark.rating) you.append(el("span", "supercrit-you-rating", starText(mark.rating)));
    link.append(you);
  }
  const existing = document.querySelector(".supercrit-detail");
  if (existing) existing.replaceWith(link);
  else anchor.after(link);
}

function syncDetail() {
  if (!settings.ratings) return document.querySelector(".supercrit-detail")?.remove();
  const path = location.pathname;
  if (detail && detail.path !== path) {
    detail = null;
    document.querySelector(".supercrit-detail")?.remove();
  }
  if (detail) {
    if (!document.querySelector(".supercrit-detail")) renderDetail();
    return;
  }
  const id = criterionId(path);
  if (!id || detailTried === path) return;
  detailTried = path;
  const here = () => location.pathname === path;
  criterionMetaFor(id, here, document.querySelector(SEL.detailTitle)?.textContent.trim())
    .then((meta) => meta && here() && lookup(meta))
    .then((film) => {
      if (!film || !here()) return;
      detail = { path, film };
      renderDetail();
    })
    .catch((err) => {
      if (!(err instanceof Cancelled)) console.warn("[supercrit]", path, err);
    });
}

// ---------- Cards ----------

// Paints straight from the in-memory cache; returns true only if nothing needs refreshing.
function paintFromCache(card, { id, container }) {
  const meta = knownMeta(card, id);
  if (!meta) return false;
  card.dataset.supercritKey = lbKey(meta);
  const film = cachedFilm(lbKey(meta));
  if (!film?.v) return false;
  renderBadge(container, film.v);
  return !film.stale;
}

function repaint(key, film) {
  if (!film) return;
  for (const card of document.querySelectorAll(`[data-supercrit-key="${CSS.escape(key)}"]`)) {
    const parts = cardParts(card);
    if (parts) renderBadge(parts.container, film);
  }
}

// Every card whose film is known, e.g. after the user's watched films sync or a new snapshot.
// One pass over the keyed cards, rather than a query per key, since a snapshot carries every film
// in the catalog.
function repaintAll() {
  for (const card of document.querySelectorAll("[data-supercrit-key]")) {
    const film = cachedFilm(card.dataset.supercritKey)?.v;
    const parts = film && cardParts(card);
    if (parts) renderBadge(parts.container, film);
  }
  if (detail) renderDetail();
}

// Results arrive in bursts — the worker resolving every snapshot miss on the page, or a sync
// rewriting the user's films — so the changes are collected and applied once per frame.
const dirtyKeys = new Map(); // lbKey -> the film that just landed
let dirtyAll = false;
let refilter = false;
let flushQueued = false;

function queueFlush() {
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    flushQueued = false;
    if (dirtyAll) repaintAll();
    else for (const [key, film] of dirtyKeys) repaint(key, film);
    dirtyKeys.clear();
    dirtyAll = false;
    // A rating or a mark arriving can move a film in or out of the current filter.
    if (refilter && filtering()) applyFilters();
    refilter = false;
  });
}

// A stale score is shown first and refreshed in the background, and a new snapshot can land
// mid-visit (e.g. just after install); repaint the affected cards either way.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key.startsWith("lb:")) {
      dirtyKeys.set(key, newValue?.v);
      refilter = true;
    }
    // Both touch every card, so they're a single pass rather than one per film.
    if (key === SNAPSHOT_KEY || key === USER_KEY || key === USERNAME_KEY) {
      dirtyAll = true;
      refilter = true;
    }
    if (key === USERNAME_KEY) panel?.sync();
    if (key === SETTINGS_KEY) applySettings(normalizeSettings(newValue?.v));
    // Another tab changed the filters.
    if (key === FILTERS_KEY && JSON.stringify(newValue?.v) !== JSON.stringify(filters)) {
      filters = normalizeFilters(newValue?.v);
      panel?.sync();
      refilter = true;
    }
  }
  queueFlush();
});

function settle(card, state) {
  visibility.unobserve(card);
  nearCards.delete(card);
  card.dataset.supercrit = state;
}

// data-supercrit on each card records its outcome, for diagnosing misses from DevTools.
async function processCard(card) {
  const parts = cardParts(card);
  if (!parts) return settle(card, "not-a-film");
  const { id, container } = parts;
  busyCards.add(card);
  card.dataset.supercrit = "pending";
  const wanted = () => nearCards.has(card) && seenCards.get(card) === id;
  try {
    const meta = await criterionMetaFor(id, wanted, printedTitle(card));
    if (!meta) return settle(card, "no-criterion-meta");
    card.dataset.supercritQuery = `${meta.title} | ${meta.year} | ${meta.directors.join(", ")}`;
    card.dataset.supercritKey = lbKey(meta);
    if (!wanted()) throw new Cancelled();
    const film = await lookup(meta);
    if (!film) return settle(card, "no-letterboxd-match");
    // The card may have been handed to another film while this was in flight.
    if (seenCards.get(card) !== id) return;
    renderBadge(container, film);
    settle(card, film.rating == null ? "no-rating" : "ok");
  } catch (err) {
    // The extension was reloaded under this page; this script is orphaned until the tab is refreshed.
    if (!chrome.runtime?.id) {
      visibility.disconnect();
      delete card.dataset.supercrit;
      return;
    }
    // Scrolled away before its turn; still observed, so it resumes when it comes back into view.
    if (err instanceof Cancelled) return (card.dataset.supercrit = "deferred");
    const attempts = (+card.dataset.supercritAttempts || 0) + 1;
    card.dataset.supercritAttempts = attempts;
    settle(card, err instanceof TransientError ? err.message : `error: ${err}`);
    console.warn("[supercrit]", id, err);
    if (err instanceof TransientError && attempts < MAX_ATTEMPTS) {
      setTimeout(() => visibility.observe(card), 2000 * 2 ** attempts);
    }
  } finally {
    busyCards.delete(card);
    // Handed a new film mid-flight: the observer won't fire again for a card already in view.
    if (seenCards.get(card) !== id && nearCards.has(card)) processCard(card);
  }
}

// Cards stay observed until settled, so leaving and re-entering the viewport is tracked.
const visibility = new IntersectionObserver(
  (entries) => {
    for (const { target: card, isIntersecting } of entries) {
      if (!isIntersecting) {
        nearCards.delete(card);
        continue;
      }
      nearCards.add(card);
      // A retry scheduled before ratings were turned off still re-observes its card.
      if (settings.ratings && !busyCards.has(card)) processCard(card);
    }
  },
  { rootMargin: "300px" }
);

// React keeps card elements across renders, so a card can be handed a different film (a rail
// re-sorting, All Films changing its sort) or have its artwork re-rendered without our badge. A
// card is taken up again whenever its film differs from the one it was scanned for, or its badge
// has gone missing.
function stale(card, parts) {
  if (!seenCards.has(card)) return true;
  if (seenCards.get(card) !== (parts?.id ?? null)) {
    parts?.container.querySelector(".supercrit-badge")?.remove();
    delete card.dataset.supercritKey;
    return true;
  }
  const painted = card.dataset.supercrit === "ok" || card.dataset.supercrit === "no-rating";
  return painted && !parts.container.querySelector(".supercrit-badge");
}

// Painting every known card in the scan itself is what makes a page instant: a rail's few dozen
// cards, or a page of All Films, badged in the frame the markup lands in, with no observer round trip.
function scanCards() {
  syncDetail();
  syncAllFilms();
  if (!settings.ratings) return;
  for (const card of document.querySelectorAll(SEL.card)) {
    const parts = cardParts(card);
    if (!stale(card, parts)) continue;
    seenCards.set(card, parts?.id ?? null);
    if (parts && paintFromCache(card, parts)) {
      card.dataset.supercrit = "ok";
      continue;
    }
    visibility.observe(card);
  }
}

let scanQueued = false;
let started = false;

function start() {
  started = true;
  settings = normalizeSettings(cachePeek(SETTINGS_KEY)?.v);
  filters = normalizeFilters(cachePeek(FILTERS_KEY)?.v);
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scanCards();
    });
  }).observe(document.body, { childList: true, subtree: true });
  scanCards();
}

// A feature switched in the popup mid-visit. Ratings start over: the badges drawn are removed and
// every card forgotten, so turning them back on rescans the page as if it had just loaded. The
// detail line and the filter panel draw or remove themselves on the next scan, and marks are
// redrawn with the badges they sit on.
function applySettings(next) {
  const prev = settings;
  settings = next;
  if (!started) return; // start() reads them itself, once the page is ready
  if (prev.ratings !== next.ratings) {
    visibility.disconnect();
    seenCards = new WeakMap();
    nearCards = new WeakSet();
    document.querySelectorAll(".supercrit-badge").forEach((n) => n.remove());
    for (const card of document.querySelectorAll("[data-supercrit]")) {
      for (const name of ["supercrit", "supercritKey", "supercritQuery", "supercritAttempts"]) delete card.dataset[name];
    }
  }
  if (prev.marks !== next.marks) {
    dirtyAll = true;
    refilter = true;
    panel?.sync();
  }
  scanCards();
}

// ---------- All Films filters ----------
// All Films (ALL_FILMS_PATH) gets a "Letterboxd" group at the top of its filter panel, asking only
// what Letterboxd knows and the site's own filters can't: minimum rating, runtime range, and the
// user's watched/watchlist state. The rules are pure functions in lib/criterion.js.
//
// The page loads its grid 60 films at a time as you scroll, so hiding the cards that fail would
// leave a strict filter with a near-empty page — and the site's loader doesn't fire again for a
// sentinel already in view. So while a filter is on, the site's grid is set aside and ours takes
// its place: the whole list comes from the API the page itself uses, with the page's own query
// string, so the site's genres, decades, countries, directors and sort all still apply; each film
// that passes is drawn as a copy of one of the site's own cards. To the rest of this script those
// copies are ordinary cards, so they get their badges the usual way.
const FILTERS_KEY = "catalog:filters";
const FILTERS_TTL = 3650 * DAY_MS;
const RESULTS_PAGE = 60; // cards drawn at a time, as the site does
const RESULTS_AHEAD_PX = 1500; // how far below the viewport the next batch is drawn

let filters = DEFAULT_FILTERS;
const onAllFilms = () => location.pathname === ALL_FILMS_PATH;
// Filters chosen before the feature was turned off are kept, and apply again when it's back on.
const filtering = () => settings.filters && !isDefaultFilters(filters);

// The site's list for a query string, every page of it, kept for the visit.
const catalogs = new Map(); // location.search -> Promise<films[]>

function loadCatalog(search) {
  if (!catalogs.has(search)) {
    const page = async (key) => {
      const res = await politeFetch(criterionLimit, allFilmsUrl(key, search));
      if (!res.ok) throw new TransientError(`criterion-http-${res.status}`);
      return parseAllFilms(await res.json());
    };
    const pending = (async () => {
      const first = await page("1");
      let pages = [first];
      if (/^\d+$/.test(first.next || "") && first.total) {
        // Keys are page numbers, so the rest can be asked for at once.
        const last = Math.ceil(first.total / ALL_FILMS_PAGE);
        const keys = [];
        for (let p = +first.next; p <= last; p++) keys.push(String(p));
        pages = pages.concat(await Promise.all(keys.map(page)));
      } else {
        for (let next = first.next; next; ) {
          const more = await page(next);
          pages.push(more);
          next = more.next;
        }
      }
      const byId = new Map();
      for (const { films } of pages) for (const film of films) byId.set(film.id, film);
      return [...byId.values()];
    })();
    pending.catch(() => catalogs.delete(search)); // retried on the next change
    catalogs.set(search, pending);
  }
  return catalogs.get(search);
}

// Everything the filters ask about. The runtime is Criterion's own, which every film has; the
// rating and the user's history need a Letterboxd match, so a film without one fails an active
// rating or watched filter rather than showing an unknown.
function filmFacts(film) {
  // A film the catalog dates badly (year null) was looked up with the year from its own record.
  const meta = film.year ? film : cachedMeta(film.id, film.title) || film;
  const lb = cachedFilm(lbKey(meta))?.v;
  return { rating: lb?.rating ?? null, runtime: film.runtime ?? lb?.runtime ?? null, mark: lb ? markFor(lb) : null };
}

// Our cards are copies of the site's, so they look like its own whatever it changes. The template
// is a clean copy of the first card seen, and each film's card is kept once made, so a filter
// change moves cards rather than rebuilding them and their artwork isn't fetched again.
let cardTemplate = null;
const copies = new Map(); // film id -> card

function stripOurs(root) {
  root.querySelectorAll(".supercrit-badge").forEach((n) => n.remove());
  for (const node of [root, ...root.querySelectorAll("*")]) {
    node.classList.remove("supercrit-anchor", "supercrit-hidden");
    for (const { name } of [...node.attributes]) if (name.startsWith("data-supercrit")) node.removeAttribute(name);
  }
}

function captureTemplate(grid) {
  if (cardTemplate) return;
  const item = [...grid.children].find((child) => child.querySelector(SEL.card) && child.querySelector(SEL.cardLink));
  if (!item) return;
  const copy = item.cloneNode(true);
  stripOurs(copy);
  copy.querySelectorAll(SEL.cardInert).forEach((n) => n.remove());
  // The site lazy-loads through a script that only knows its own images; ours use the browser's.
  const img = copy.querySelector("img");
  if (img) {
    for (const name of ["src", "srcset", "data-src", "data-srcset", "data-sizes"]) img.removeAttribute(name);
    img.className = [...img.classList].filter((c) => !/^(lazy|ls-)/.test(c)).join(" ");
    img.loading = "lazy";
    img.decoding = "async";
  }
  cardTemplate = copy;
}

function cardFor(film) {
  let item = copies.get(film.id);
  if (item) return item;
  item = cardTemplate.cloneNode(true);
  const titleId = `supercrit-title-${film.id}`;
  const link = item.querySelector(SEL.cardLink);
  if (link) {
    link.href = filmHref(film);
    link.setAttribute("aria-labelledby", titleId);
  }
  const title = item.querySelector(SEL.cardTitle);
  if (title) {
    title.textContent = film.title;
    title.id = titleId;
  }
  const year = item.querySelector(SEL.cardYear);
  if (year) year.textContent = film.year ?? "";
  const runtime = item.querySelector(SEL.cardRuntime);
  if (runtime) runtime.textContent = formatRuntime(film.runtime);
  const img = item.querySelector("img");
  if (img) {
    img.alt = film.title;
    img.srcset = POSTER_WIDTHS.map((w) => `${posterUrl(film.id, w)} ${w}w`).join(", ");
    img.src = posterUrl(film.id, 640);
  }
  copies.set(film.id, item);
  return item;
}

// Our results, drawn in place of the site's grid while a filter is on. Built once and moved in and
// out of the page as filters and pages change.
let results = null;
let catalogFor = null; // the query string the list below is for
let catalogFilms = null; // that list, once loaded
let shown = RESULTS_PAGE;

function resultsParts() {
  if (results) return results;
  const status = el("div", "supercrit-status");
  const count = el("span", "supercrit-status-count");
  const clear = button("supercrit-link", "Clear");
  status.append(el("span", "supercrit-status-label", "Letterboxd filters"), count, clear);
  const empty = el("div", "supercrit-empty");
  const clearEmpty = button("supercrit-link", "Clear filters");
  empty.append(el("span", null, "No films match these filters."), clearEmpty);
  const grid = el("ul", "supercrit-grid");
  const more = el("div", "supercrit-more");
  clear.addEventListener("click", clearFilters);
  clearEmpty.addEventListener("click", clearFilters);
  // The next batch is drawn as the end of this one comes near. The observer only reports changes,
  // so after drawing, a sentinel still in reach asks again rather than waiting on a scroll.
  const extend = () => {
    if (more.hidden || !more.isConnected) return;
    if (more.getBoundingClientRect().top > innerHeight + RESULTS_AHEAD_PX) return;
    shown += RESULTS_PAGE;
    applyFilters();
    requestAnimationFrame(extend);
  };
  new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && extend(), {
    rootMargin: `${RESULTS_AHEAD_PX}px`,
  }).observe(more);
  results = { status, count, empty, grid, more, parts: [status, empty, grid, more] };
  return results;
}

function removeResults() {
  if (results?.status.isConnected) results.parts.forEach((n) => n.remove());
}

function applyFilters() {
  const siteGrid = onAllFilms() && document.querySelector(SEL.allFilmsGrid);
  if (!siteGrid) return removeResults();
  captureTemplate(siteGrid);
  const active = filtering();
  siteGrid.classList.toggle("supercrit-hidden", active);
  document.querySelector(SEL.allFilmsLoader)?.classList.toggle("supercrit-hidden", active);
  if (!active) return removeResults();

  const r = resultsParts();
  // Styled as the site's grid, whatever its classes are now.
  r.grid.className = [...siteGrid.classList].filter((c) => !c.startsWith("supercrit-")).concat("supercrit-grid").join(" ");
  if (siteGrid.nextElementSibling !== r.status) {
    siteGrid.after(...r.parts);
    // The grid insets its cards with its own padding; the lines above it line up with the cards.
    const { paddingLeft, paddingRight } = getComputedStyle(r.grid);
    for (const line of [r.status, r.empty]) {
      line.style.marginLeft = paddingLeft;
      line.style.marginRight = paddingRight;
    }
  }

  const search = location.search;
  if (catalogFor !== search) {
    catalogFor = search;
    catalogFilms = null;
    shown = RESULTS_PAGE;
    loadCatalog(search).then(
      (films) => {
        if (catalogFor !== search) return;
        catalogFilms = films;
        applyFilters();
      },
      (err) => {
        if (catalogFor !== search) return;
        console.warn("[supercrit] All Films list", err);
        catalogFor = null; // try again on the next change
        r.count.textContent = "Couldn't load the list of films";
      }
    );
  }
  if (!catalogFilms) {
    if (catalogFor === search) r.count.textContent = "Loading…";
    r.empty.hidden = true;
    r.more.hidden = true;
    r.grid.replaceChildren();
    return;
  }

  const matched = catalogFilms.filter((film) => matchesFilters(filmFacts(film), filters));
  r.count.textContent = `${formatCount(matched.length)} of ${formatCount(catalogFilms.length)} films`;
  r.empty.hidden = matched.length > 0;
  r.more.hidden = matched.length <= shown;
  // The template comes from the site's grid, which shows this same query; if that's still
  // loading, the next mutation brings both.
  const cards = cardTemplate ? matched.slice(0, shown).map(cardFor) : [];
  const current = r.grid.children;
  if (cards.length !== current.length || cards.some((card, i) => card !== current[i])) r.grid.replaceChildren(...cards);
}

function commitFilters(patch) {
  filters = normalizeFilters({ ...filters, ...patch });
  shown = RESULTS_PAGE;
  applyFilters();
  cacheSet(FILTERS_KEY, filters, FILTERS_TTL).catch(() => {});
}

function clearFilters() {
  commitFilters(DEFAULT_FILTERS);
  panel?.sync();
}

// Picks one film at random from the site's current query (genres, decades, sort, …) narrowed by
// our own filters, and goes there — a full navigation, since there's nowhere "random" to land a
// client-side route on. Uses the same catalog as the results grid, so a repeat click after it's
// loaded is instant.
async function pickRandomFilm(label) {
  const search = location.search;
  const original = label.textContent;
  label.closest("button").disabled = true;
  label.textContent = "Finding…";
  let note = null;
  try {
    const films = await loadCatalog(search);
    if (location.search !== search || !onAllFilms()) return;
    const matched = films.filter((film) => matchesFilters(filmFacts(film), filters));
    if (!matched.length) {
      note = "No matches";
      return;
    }
    location.href = filmHref(matched[Math.floor(Math.random() * matched.length)]);
    return; // navigating away; nothing left to reset
  } catch (err) {
    console.warn("[supercrit] random film", err);
    note = "Couldn't load";
  } finally {
    if (label.isConnected) {
      label.textContent = note ?? original;
      label.closest("button").disabled = false;
      if (note) setTimeout(() => label.isConnected && (label.textContent = original), 1500);
    }
  }
}

// Run on every DOM change: the page is rendered client-side, so the panel and grid can appear, be
// replaced, or be navigated away from at any time. Cheap when nothing has moved.
function syncAllFilms() {
  if (!onAllFilms()) {
    header?.root.remove();
    return removeResults();
  }
  ensureHeader();
  if (settings.filters) ensurePanel();
  else panel?.root.remove();
  const siteGrid = document.querySelector(SEL.allFilmsGrid);
  if (!siteGrid) return;
  if (!cardTemplate) captureTemplate(siteGrid);
  const active = filtering();
  const loader = document.querySelector(SEL.allFilmsLoader);
  const settled =
    siteGrid.classList.contains("supercrit-hidden") === active &&
    (!loader || loader.classList.contains("supercrit-hidden") === active) &&
    (!active || (siteGrid.nextElementSibling === results?.status && catalogFor === location.search));
  if (!settled) applyFilters();
}

// A header above the grid, independent of whether a Letterboxd filter is active: it works off
// whatever's currently showing, ours or the site's own (genre, decade, sort, …), or the whole
// catalog if nothing is filtering at all.
let header = null; // { root }

function ensureHeader() {
  const siteGrid = document.querySelector(SEL.allFilmsGrid);
  if (!siteGrid) return;
  if (!header) {
    const root = el("div", "supercrit-header");
    const label = el("span", null, "Random");
    const random = button("supercrit-random", null);
    random.append(icon(DICE), label);
    random.addEventListener("click", () => pickRandomFilm(label));
    root.append(random);
    header = { root };
  }
  // The grid insets its cards with its own padding; a plain sibling of it (unlike the status line,
  // which is styled to match) would otherwise sit flush against the column's outer edge, under
  // where the filter sidebar actually is.
  const { paddingLeft, paddingRight } = getComputedStyle(siteGrid);
  header.root.style.marginLeft = paddingLeft;
  header.root.style.marginRight = paddingRight;
  if (siteGrid.previousElementSibling !== header.root) siteGrid.before(header.root);
}

// ---------- The panel ----------
// A copy of one of the site's own accordions, so it reads as one more group beside Genres and
// Decades. The site's accordions are React's; ours is a plain copy with its own handler, toggling
// the same classes the site does (STATE_CLASSES in lib/site.js).
let panel = null; // { root, sync }

function ensurePanel() {
  const label = document.querySelector(SEL.filterSectionLabel);
  if (!label) return;
  if (!panel) {
    // A closed accordion doesn't render its body at all, so the copy is of one that's open —
    // a filter group if one is, otherwise Sort, which starts open. Its state is reset below.
    const hasBody = (a) => a.querySelector('[role="region"]')?.querySelector(SEL.accordionContent);
    const models = [...label.parentElement.querySelectorAll(SEL.accordion)].filter(hasBody);
    const model = models.find((a) => label.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) || models[0];
    if (!model) return;
    panel = buildPanel(model);
    if (!panel) return;
  }
  // First among the filters, ahead of the site's own groups.
  if (label.nextElementSibling !== panel.root) {
    label.after(panel.root);
    panel.sync();
  }
}

function button(className, text) {
  const node = el("button", className, text);
  node.type = "button";
  return node;
}

// One of the site's filter options (a pill), or a plain button if there's none to copy. A closed
// filter group doesn't render its options, so a Sort option stands in, turned into a filter one.
function optionButton(label) {
  const model = document.querySelector(SEL.filterOption) || document.querySelector(SEL.sortOption);
  if (!model) return button("supercrit-option", label);
  const node = model.cloneNode(true);
  node.removeAttribute("id");
  node.type = "button";
  const asFilter = stateClass(node, "sortOptionAsFilter");
  if (asFilter) {
    node.classList.remove([...node.classList].find((c) => c.endsWith("__kindSort")));
    node.classList.add(asFilter);
  }
  const active = stateClass(node, "filterOptionActive");
  if (active) node.classList.remove(active);
  // Just the label: a sort option also carries its direction arrow.
  const text = node.querySelector(SEL.filterOptionLabel);
  if (text) {
    text.textContent = label;
    node.replaceChildren(text);
  } else node.textContent = label;
  node.classList.add("supercrit-option");
  return node;
}

// Options where at most one is on, so clicking the chosen one turns it off (value null).
function panelChoices(options, valueFor, onChange) {
  const list = el("div", "supercrit-options");
  const buttons = options.map(({ value, label }) => {
    const node = optionButton(label);
    node.addEventListener("click", () => onChange(valueFor() === value ? null : value));
    list.append(node);
    return { value, node };
  });
  const sync = () => {
    for (const { value, node } of buttons) {
      const on = valueFor() === value;
      node.setAttribute("aria-pressed", on);
      const active = stateClass(node, "filterOptionActive");
      if (active) node.classList.toggle(active, on);
      node.classList.toggle("supercrit-option--on", on);
    }
  };
  return { list, sync };
}

function panelSection(title) {
  const section = el("div", "supercrit-section");
  section.append(el("h4", "supercrit-section-title", title));
  return section;
}

// Reads the pair back the way the ends are meant: a handle on an end is no bound there.
function runtimeLabel({ runtimeMin, runtimeMax }) {
  const floor = runtimeMin > RUNTIME_MIN;
  const ceiling = runtimeMax < RUNTIME_MAX;
  if (!floor && !ceiling) return null; // the whole track: no filter at all
  if (floor && ceiling) return runtimeMin === runtimeMax ? `${runtimeMin} min` : `${runtimeMin} to ${runtimeMax} min`;
  return floor ? `${runtimeMin} min and over` : `${runtimeMax} min and under`;
}

// Runtime is a range, and HTML has no two-handle slider. Two range inputs are stacked on one
// track instead, each drawing only its thumb (the CSS hides their own tracks and paints ours), so
// both keep native focus and arrow keys — which a div-and-pointer-events widget would give up.
// Each handle pushes the other rather than stopping against it, so neither can be crossed.
function rangeSlider(read, commit) {
  const rangeInput = (which, label) => {
    const input = document.createElement("input");
    input.type = "range";
    input.className = `supercrit-range-input supercrit-range-input--${which}`;
    input.min = RUNTIME_MIN;
    input.max = RUNTIME_MAX;
    input.step = RUNTIME_STEP;
    input.setAttribute("aria-label", label);
    return input;
  };
  const lo = rangeInput("lo", "Shortest runtime, in minutes");
  const hi = rangeInput("hi", "Longest runtime, in minutes");
  const fill = el("div", "supercrit-range-fill");
  const track = el("div", "supercrit-range");
  track.append(fill, lo, hi);
  const value = el("span", "supercrit-slider-value");
  const row = el("div", "supercrit-slider-row");
  row.append(track, value);

  // Both ends of the fill land on a knob's centre, and a knob sits half its own width inside the
  // rail, so the offsets are measured the way the native track measures them.
  const frac = (n) => (n - RUNTIME_MIN) / (RUNTIME_MAX - RUNTIME_MIN);
  const atKnob = (f) => `calc(8px + ${f} * (100% - 16px))`;
  const sync = () => {
    const f = read();
    lo.value = f.runtimeMin;
    hi.value = f.runtimeMax;
    fill.style.left = atKnob(frac(f.runtimeMin));
    fill.style.right = atKnob(1 - frac(f.runtimeMax));
    // With both handles on the same end only one can be on top, and it has to be the one that can
    // still move: at the far end that's the low handle, everywhere else the high one.
    lo.classList.toggle("supercrit-range-input--front", f.runtimeMin > (RUNTIME_MIN + RUNTIME_MAX) / 2);
    const label = runtimeLabel(f);
    value.replaceChildren(label ? el("span", null, label) : el("span", "supercrit-any", "Any length"));
  };

  lo.addEventListener("input", () => {
    const v = +lo.value;
    commit({ runtimeMin: v, runtimeMax: Math.max(v, read().runtimeMax) });
    sync();
  });
  hi.addEventListener("input", () => {
    const v = +hi.value;
    commit({ runtimeMax: v, runtimeMin: Math.min(v, read().runtimeMin) });
    sync();
  });

  return { row, sync };
}

function buildPanel(model) {
  const root = model.cloneNode(true);
  const head = root.querySelector(SEL.accordionButton);
  const title = root.querySelector(SEL.accordionTitle);
  const accordionIcon = root.querySelector(SEL.accordionIcon);
  const region = root.querySelector('[role="region"]');
  const content = root.querySelector(SEL.accordionContent);
  if (!head || !title || !region || !content) return null;
  for (const node of [root, ...root.querySelectorAll("[id]")]) node.removeAttribute("id");
  root.classList.add("supercrit-accordion");
  head.id = "supercrit-accordion-head";
  region.id = "supercrit-accordion-body";
  head.setAttribute("aria-controls", region.id);
  head.setAttribute("aria-label", "Letterboxd");
  region.setAttribute("aria-labelledby", head.id);
  title.textContent = "Letterboxd";
  // Just the open/closed icon: anything else beside it (a count of chosen options) is the site's.
  // The site draws a different icon for each state (minus, plus) rather than restyling one, so
  // ours swaps between copies of both; the model is open, so the closed one comes from elsewhere.
  const right = root.querySelector(SEL.accordionRight);
  const closedModel = [...document.querySelectorAll(SEL.accordionButton)].find(
    (b) => b.getAttribute("aria-expanded") === "false"
  );
  const closedIcon = closedModel?.querySelector(SEL.accordionIcon)?.cloneNode(true);
  if (right && accordionIcon) right.replaceChildren(accordionIcon);

  let open = true;
  const setOpen = (value) => {
    open = value;
    head.setAttribute("aria-expanded", open);
    const titleOpen = stateClass(title, "accordionTitleOpen");
    if (titleOpen) title.classList.toggle(titleOpen, open);
    if (accordionIcon && closedIcon) {
      right.replaceChildren(open ? accordionIcon : closedIcon);
    } else {
      const iconOpen = accordionIcon && stateClass(accordionIcon, "accordionIconOpen");
      if (iconOpen) accordionIcon.classList.toggle(iconOpen, open);
    }
    // The site animates its own regions with inline height and opacity.
    region.style.height = open ? "auto" : "0px";
    region.style.opacity = open ? "1" : "0";
    region.style.overflow = open ? "" : "hidden";
    region.inert = !open;
  };
  head.addEventListener("click", () => setOpen(!open));

  const body = el("div", "supercrit-filter-body");

  // Rating, as a slider: the useful range is narrow (most of the catalog sits between 3 and 4),
  // so tenths are what separate "good" from "great" here, and a list of bands would be too coarse.
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "supercrit-slider";
  slider.min = 0;
  slider.max = MAX_MIN_RATING;
  slider.step = 0.1;
  slider.setAttribute("aria-label", "Minimum Letterboxd rating");
  const sliderValue = el("span", "supercrit-slider-value");
  const syncSlider = () => {
    slider.value = filters.minRating;
    slider.style.setProperty("--supercrit-fill", filters.minRating / MAX_MIN_RATING);
    sliderValue.replaceChildren(
      ...(filters.minRating
        ? [el("span", "supercrit-star", "★"), el("span", null, `${filters.minRating.toFixed(1)} and up`)]
        : [el("span", "supercrit-any", "Any rating")])
    );
  };
  slider.addEventListener("input", () => {
    commitFilters({ minRating: +slider.value });
    syncSlider();
  });
  const rating = panelSection("Rating");
  const ratingRow = el("div", "supercrit-slider-row");
  ratingRow.append(slider, sliderValue);
  rating.append(ratingRow);

  const runtime = rangeSlider(() => filters, commitFilters);
  const runtimeSection = panelSection("Runtime");
  runtimeSection.append(runtime.row);

  // "Everything" is the absence of this filter, so it isn't offered as an option to pick.
  const seen = panelChoices(
    SEEN_OPTIONS.filter((o) => o.value !== "all"),
    () => filters.seen,
    (value) => commitFilters({ seen: value || "all" })
  );
  const seenSection = panelSection("Watched");
  const seenHint = el("p", "supercrit-hint");
  seenSection.append(seen.list, seenHint);

  body.append(rating, runtimeSection, seenSection);
  content.replaceChildren(body);
  setOpen(true);

  const sync = () => {
    // Nothing to compare against until a username is set in the popup, or with marks turned off
    // there; a "watched" filter left over would hide films with no visible way to bring them back.
    const named = !!cachePeek(USERNAME_KEY)?.v;
    const usable = named && settings.marks;
    if (!usable && filters.seen !== "all") commitFilters({ seen: "all" });
    seenSection.classList.toggle("supercrit-section--off", !usable);
    seenHint.textContent = named
      ? "Turn on your watched films in the Supercrit popup."
      : "Add your Letterboxd username in the Supercrit popup.";
    seenHint.hidden = usable;
    syncSlider();
    runtime.sync();
    seen.sync();
  };
  return { root, sync };
}

// This script runs at document_start, so the cache read above is already in flight while the page
// is still parsing. Painting needs both it and the DOM: the mirror so the first scan can badge every
// known card at once, and the markup the cards live in, once React has hydrated it (below). Cards
// added later are caught by the observer.
const domReady =
  document.readyState === "loading"
    ? new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }))
    : Promise.resolve();

// The page is server-rendered and then hydrated by React, which expects the DOM to be exactly what
// the server sent: a badge added before then is a hydration mismatch (React error #418), and React
// throws that markup away and renders it again. So nothing is drawn until the site shows it has
// hydrated, with a timeout in case that signal ever goes away.
const HYDRATION_TIMEOUT_MS = 5000;
const hydrated = domReady.then(
  () =>
    new Promise((resolve) => {
      if (document.querySelector(SEL.hydrated)) return resolve();
      const watch = new MutationObserver(() => {
        if (document.querySelector(SEL.hydrated)) finish();
      });
      const timer = setTimeout(finish, HYDRATION_TIMEOUT_MS);
      function finish() {
        watch.disconnect();
        clearTimeout(timer);
        resolve();
      }
      watch.observe(document.body, { childList: true });
    })
);

Promise.all([cacheReady.catch((err) => console.warn("[supercrit] cache load failed", err)), hydrated]).then(start);

// Pick up films logged or watchlisted since the last visit; marks repaint when the sync lands.
chrome.runtime.sendMessage({ type: "syncUser", maxAge: USER_REFRESH_MS }).catch(() => {});
