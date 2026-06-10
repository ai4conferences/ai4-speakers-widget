/**
 * Ai4 Speakers Widget — Cloudflare Worker (v6d)
 * =============================================
 *
 * Proxies the Swapcard Content API. Holds SWAPCARD_API_KEY as a secret.
 * Caches a single full-data payload at the edge; projects to two response
 * shapes for the two public endpoints.
 *
 * Endpoints:
 *   GET /speakers       — LEAN list (no bio/sessions/socials). Used for
 *                         initial card render. ~400 KB for ~600 speakers.
 *   GET /speakers/:id   — FULL record (bio, sessions+co-speakers, socials,
 *                         website). Fetched on-demand when user opens a
 *                         speaker modal. ~3-15 KB per record.
 *   GET /diagnostics    — Schema discovery: groups + custom field definitions
 *
 * v5 changes from v4:
 *   - Split into lean-list + per-speaker-detail endpoints. Initial page load
 *     downloads ~400 KB instead of ~2 MB. Modal opens trigger a small
 *     follow-up fetch for the speaker's full record.
 *   - Single internal cache holds the full normalized speaker list; both
 *     endpoints project from it. Detail lookups also tolerate co-speaker
 *     IDs (communityProfile.id) by falling back to a name index.
 *
 * Setup:
 *   wrangler secret put SWAPCARD_API_KEY --env staging
 *   wrangler deploy --env staging
 */

const SWAPCARD_ENDPOINT = "https://developer.swapcard.com/event-admin/graphql";
const CACHE_TTL_SECONDS = 1800; // 30 min — wider safety buffer for 5-min cron
// Page size for paginating Swapcard's eventPerson query. Bigger = fewer
// round-trips. If Swapcard rejects 500 with a "page size too large" error,
// drop this to 250 or 200.
const PAGE_SIZE = 500;
const DEFAULT_FEATURED_ORDER_FIELD = "Featured Order";

// ============================================================
//  GraphQL queries
// ============================================================

const GROUPS_QUERY = /* GraphQL */ `
  query EventGroups($eventId: ID!) {
    event(id: $eventId) {
      id
      groups { id name peopleCount priority isDefault }
    }
  }
`;

const FIELD_DEFINITIONS_QUERY = /* GraphQL */ `
  query AllEventCustomFields($eventId: ID!, $target: FieldDefinitionTargetEnum!) {
    event(id: $eventId) {
      fieldDefinitions(target: $target) {
        __typename
        ... on NumberFieldDefinition       { id name }
        ... on UrlFieldDefinition          { id name }
        ... on MediaFieldDefinition        { id name }
        ... on TextFieldDefinition         { id name }
        ... on LongTextFieldDefinition     { id name }
        ... on SelectFieldDefinition       { id name }
        ... on MultipleSelectFieldDefinition { id name }
        ... on MultipleTextFieldDefinition { id name }
        ... on DateFieldDefinition         { id name }
      }
    }
  }
`;

/**
 * People query.
 *
 * Note: speakerOnPlannings returns the sessions where this person is a speaker.
 * The Swapcard schema docs show speakerOnPlannings { id title } as the minimal
 * shape — we extend it with the fields we need for the session view of the
 * modal. If the schema rejects any of these, hit /diagnostics to introspect
 * and adjust.
 */
const PEOPLE_QUERY = /* GraphQL */ `
  query EventSpeakers($eventId: ID!, $cursor: CursorPaginationInput) {
    eventPerson(eventId: $eventId, cursor: $cursor) {
      pageInfo { hasNextPage endCursor }
      totalCount
      nodes {
        id
        firstName
        lastName
        jobTitle
        organization
        photoUrl
        biography
        websiteUrl
        socialNetworks { profile type }
        groups { id name }
        speakerOnPlannings {
          id
          beginsAt
          endsAt
          bannerUrl
          titleTranslations { value language }
          descriptionTranslations { value language }
          type
          events { nodes { id } }
          speakers {
            communityProfile {
              id
              firstName
              lastName
              jobTitle
              organization
              photoUrl
            }
          }
        }
        withEvent(eventId: $eventId) {
          isVisible
          fields {
            __typename
            ... on SelectField {
              translations { value language }
              definition { id translations { name language } }
            }
            ... on MultipleSelectField {
              translations { value language }
              definition { id translations { name language } }
            }
            ... on NumberField {
              value
              definition { id translations { name language } }
            }
          }
        }
      }
    }
  }
`;

// ============================================================
//  Worker entry
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = buildCorsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);

    try {
      if (url.pathname === "/diagnostics") return await handleDiagnostics(env, cors);
      if (url.pathname === "/speakers" || url.pathname === "/") {
        return await handleSpeakersList(request, env, ctx, cors);
      }
      // Per-speaker detail: /speakers/:id
      const detailMatch = url.pathname.match(/^\/speakers\/([^/]+)\/?$/);
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        return await handleSpeakerDetail(id, env, ctx, cors);
      }
      return json({ error: "not_found", paths: ["/speakers", "/speakers/:id", "/diagnostics"] }, 404, cors);
    } catch (err) {
      console.error("worker error:", err);
      return json({ error: "upstream_error", message: String(err.message || err) }, 502, cors);
    }
  },

  // Runs on cron triggers configured in wrangler.toml. Refreshes the full
  // speaker dataset so the lean /speakers and detail /speakers/:id endpoints
  // both serve from a warm cache. Without this, the first user every cache
  // expiry would pay ~25s of cold fetch latency.
  async scheduled(event, env, ctx) {
    try {
      await refreshSpeakerCache(env);
      console.log("scheduled cache refresh completed");
    } catch (err) {
      console.error("scheduled cache refresh failed:", err);
    }
  },
};

// ============================================================
//  /diagnostics
// ============================================================

async function handleDiagnostics(env, cors) {
  const [groupsData, fieldsData] = await Promise.all([
    swapcardQuery(env, GROUPS_QUERY, { eventId: env.EVENT_ID }),
    swapcardQuery(env, FIELD_DEFINITIONS_QUERY, { eventId: env.EVENT_ID, target: "PEOPLE" }),
  ]);

  const groups = groupsData?.event?.groups || [];
  const fields = fieldsData?.event?.fieldDefinitions || [];
  const featuredFieldName = env.FEATURED_ORDER_FIELD || DEFAULT_FEATURED_ORDER_FIELD;

  return json({
    eventId: env.EVENT_ID,
    groups,
    speakerGroupCandidates: groups.filter(g => /speaker/i.test(g.name || "") || g.isDefault),
    peopleFieldDefinitions: fields,
    featuredOrderFieldName: featuredFieldName,
    featuredOrderFieldFound: fields.find(f => f.name === featuredFieldName) || null,
    note: "If featuredOrderFieldFound.__typename is not NumberFieldDefinition, adjust the speakers query.",
  }, 200, cors);
}

// ============================================================
//  /speakers + /speakers/:id
//  ----------------------------------------------------------------
//  Both endpoints share a single cached payload containing the FULL
//  normalized speaker list. Each endpoint projects the cached data to
//  its own response shape:
//
//   /speakers      → array of lean cards (id, name, title, org, photo,
//                    customFields, featured info). For initial render.
//   /speakers/:id  → full record for one speaker (bio, sessions, socials,
//                    website). For modal open.
//
//  Caching one dataset and projecting twice avoids duplicating the
//  expensive Swapcard fetch. The scheduled handler refreshes this single
//  payload on cron.
// ============================================================

// The cache stores the FULL normalized payload so both endpoints can serve
// from it. We use one stable key regardless of incoming request URL.
function makeCacheKey(env) {
  return new Request(`https://cache.internal/speakers-full?v=${env.EVENT_ID}`, { method: "GET" });
}

// Fields that the lean /speakers card-list response carries. Anything
// outside this list lives in /speakers/:id only.
const LEAN_FIELDS = [
  "id", "fullName", "firstName", "lastName",
  "jobTitle", "organization", "photoUrl",
  "customFields", "featured", "featuredOrder",
];

function projectLean(speaker) {
  const lean = {};
  for (const k of LEAN_FIELDS) lean[k] = speaker[k];
  return lean;
}

// Returns the full speaker list from cache, or fetches+caches fresh data
// if missing. Both endpoints call this.
async function getOrFetchSpeakers(env, ctx, options = {}) {
  const cache = caches.default;
  const cacheKey = makeCacheKey(env);

  if (!options.forceRefresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return { speakers: await cached.json(), fromCache: true };
    }
  }

  const speakers = await fetchAllSpeakers(env);
  const cacheable = new Response(JSON.stringify(speakers), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });

  if (ctx) {
    ctx.waitUntil(cache.put(cacheKey, cacheable));
  } else {
    await cache.put(cacheKey, cacheable);
  }
  return { speakers, fromCache: false };
}

// Cron-only entrypoint: forces a fresh fetch and waits for the cache write
// to complete before returning.
async function refreshSpeakerCache(env) {
  await getOrFetchSpeakers(env, null, { forceRefresh: true });
}

async function handleSpeakersList(request, env, ctx, cors) {
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.has("refresh");
  const { speakers, fromCache } = await getOrFetchSpeakers(env, ctx, { forceRefresh });

  const payload = JSON.stringify({
    eventId: env.EVENT_ID,
    count: speakers.length,
    speakers: speakers.map(projectLean),
    generatedAt: new Date().toISOString(),
  });

  return new Response(payload, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "X-Cache": fromCache ? "HIT" : "MISS",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
}

async function handleSpeakerDetail(id, env, ctx, cors) {
  const { speakers, fromCache } = await getOrFetchSpeakers(env, ctx);

  // Index by ID for O(1) lookup. The main /speakers/:id case uses
  // eventPerson.id (the ID present in the lean list). For cases where the
  // frontend hits us with a co-speaker's communityProfile.id from session
  // data, we fall back to name match against the embedded session speakers.
  const speaker = speakers.find((s) => s.id === id) ||
                  findByCoSpeakerId(speakers, id);

  if (!speaker) {
    return json({ error: "not_found", id }, 404, cors);
  }

  return new Response(JSON.stringify({ speaker }), {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "X-Cache": fromCache ? "HIT" : "MISS",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
}

// Co-speaker entries inside a session use Swapcard's communityProfile.id,
// which differs from the eventPerson.id keyed on the top level. This walks
// the embedded sessions looking for a co-speaker with the given ID, then
// returns the matching top-level speaker by full name.
function findByCoSpeakerId(speakers, communityProfileId) {
  for (const s of speakers) {
    for (const session of (s.sessions || [])) {
      for (const co of (session.speakers || [])) {
        if (co.id === communityProfileId && co.fullName) {
          const target = co.fullName.trim().toLowerCase();
          const match = speakers.find((sp) =>
            (sp.fullName || '').trim().toLowerCase() === target
          );
          if (match) return match;
        }
      }
    }
  }
  return null;
}

async function fetchAllSpeakers(env) {
  const speakerGroupIds = await resolveSpeakerGroupIds(env);
  const featuredGroupId = env.FEATURED_GROUP_ID || null;
  const featuredOrderField = env.FEATURED_ORDER_FIELD || DEFAULT_FEATURED_ORDER_FIELD;

  const allPeople = [];
  let cursor = { first: PAGE_SIZE };

  for (let i = 0; i < 50; i++) {
    const data = await swapcardQuery(env, PEOPLE_QUERY, { eventId: env.EVENT_ID, cursor });
    const page = data?.eventPerson;
    if (!page) break;
    allPeople.push(...(page.nodes || []));
    if (!page.pageInfo?.hasNextPage) break;
    cursor = { first: PAGE_SIZE, after: page.pageInfo.endCursor };
  }

  // Filter to speakers in one of the speaker groups
  const speakers = allPeople.filter((p) =>
    (p.groups || []).some((g) => speakerGroupIds.includes(g.id))
  );

  // Normalize first so customFields are easy to inspect, then filter out
  // anyone with the "Widget Visibility" custom field set to "Hidden".
  // This field is managed in Swapcard: Event → Custom Fields → Widget Visibility (Select).
  return speakers
    .map((p) => normalizePerson(p, { featuredGroupId, featuredOrderField, eventId: env.EVENT_ID }))
    .filter((p) => {
      const vis = (p.customFields || []).find(f => f.name === 'Widget Visibility');
      if (!vis) return true;
      const vals = vis.values || (vis.value ? [vis.value] : []);
      return !vals.includes('Hidden');
    });
}

function normalizePerson(p, { featuredGroupId, featuredOrderField, eventId }) {
  const fields = p.withEvent?.fields || [];
  const customFields = [];
  let featuredOrder = null;

  for (const f of fields) {
    const def = f.definition;
    const defName = pickEnglish(def?.translations) || def?.name || "";
    if (!defName) continue;

    if (f.__typename === "NumberField") {
      const n = Number(f.value);
      if (defName === featuredOrderField && Number.isFinite(n)) featuredOrder = n;
      continue;
    }

    if (f.__typename === "SelectField" || f.__typename === "MultipleSelectField") {
      const value = pickEnglish(f.translations);
      if (!value) continue;
      const existing = customFields.find((cf) => cf.name === defName);
      if (existing) {
        if (!existing.values.includes(value)) existing.values.push(value);
      } else {
        customFields.push({ name: defName, values: [value] });
      }
    }
  }

  let isFeatured = featuredOrder !== null;
  if (!isFeatured && featuredGroupId) {
    isFeatured = (p.groups || []).some((g) => g.id === featuredGroupId);
  }

  // Normalize sessions (speakerOnPlannings) — extract title, time range, and
  // the list of co-speakers on each session so the modal can render the
  // "Speakers" sub-list without a second fetch.
  //
  // Filter rules (all must pass):
  //   1. Session has a valid beginsAt timestamp
  //   2. Session is not more than 30 days in the past (catches old-event
  //      sessions from speaker's prior Ai4 appearances — speakerOnPlannings
  //      returns sessions across all events for shared communityProfiles)
  //   3. If the planning has events listed, the current event must be in
  //      that list. A planning can be cross-listed across multiple Swapcard
  //      events (hence `events` is plural, returning a list). When the list
  //      is empty/missing, we don't drop the session — the date filter above
  //      handles those orphans.
  const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const sessionCutoff = Date.now() - SESSION_MAX_AGE_MS;

  const sessions = (p.speakerOnPlannings || [])
    .filter((s) => {
      if (!s.beginsAt) return false;
      const begin = new Date(s.beginsAt).getTime();
      if (Number.isNaN(begin)) return false;
      if (begin < sessionCutoff) return false;
      const eventNodes = s.events && Array.isArray(s.events.nodes) ? s.events.nodes : [];
      if (eventNodes.length > 0) {
        const inCurrentEvent = eventNodes.some((e) => e && e.id === eventId);
        if (!inCurrentEvent) return false;
      }
      return true;
    })
    .map((s) => ({
      id: s.id,
      title: pickEnglish(s.titleTranslations) || "",
      description: pickEnglish(s.descriptionTranslations) || "",
      beginsAt: s.beginsAt || null,
      endsAt: s.endsAt || null,
      bannerUrl: s.bannerUrl || "",
      type: s.type || "",
      speakers: (s.speakers || [])
        .map((sp) => sp.communityProfile)
        .filter(Boolean)
        .map((sp) => ({
          id: sp.id,
          firstName: sp.firstName || "",
          lastName: sp.lastName || "",
          fullName: [sp.firstName, sp.lastName].filter(Boolean).join(" "),
          jobTitle: sp.jobTitle || "",
          organization: sp.organization || "",
          photoUrl: sp.photoUrl || "",
        })),
    }));

  // Sort sessions chronologically (earliest first)
  sessions.sort((a, b) => {
    if (!a.beginsAt) return 1;
    if (!b.beginsAt) return -1;
    return a.beginsAt.localeCompare(b.beginsAt);
  });

  return {
    id: p.id,
    firstName: p.firstName || "",
    lastName: p.lastName || "",
    fullName: [p.firstName, p.lastName].filter(Boolean).join(" "),
    jobTitle: p.jobTitle || "",
    organization: p.organization || "",
    photoUrl: p.photoUrl || "",
    biography: p.biography || "",
    websiteUrl: p.websiteUrl || "",
    socials: (p.socialNetworks || []).map((s) => ({ type: s.type, profile: s.profile })),
    groups: (p.groups || []).map((g) => ({ id: g.id, name: g.name })),
    customFields,
    sessions,
    featured: isFeatured,
    featuredOrder,
  };
}

function pickEnglish(translations) {
  if (!Array.isArray(translations) || translations.length === 0) return "";
  const en = translations.find((t) => t.language === "en_US" || t.language === "en");
  if (en) return en.value || en.name || "";
  return translations[0].value || translations[0].name || "";
}

async function resolveSpeakerGroupIds(env) {
  if (env.SPEAKER_GROUP_IDS) {
    return env.SPEAKER_GROUP_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const data = await swapcardQuery(env, GROUPS_QUERY, { eventId: env.EVENT_ID });
  const groups = data?.event?.groups || [];
  const matches = groups.filter((g) => /speaker/i.test(g.name || "")).map((g) => g.id);
  if (matches.length === 0) {
    throw new Error("No speaker groups found. Hit /diagnostics, then set SPEAKER_GROUP_IDS env var.");
  }
  return matches;
}

// ============================================================
//  Helpers
// ============================================================

function buildCorsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  let allowOrigin = "*";
  if (allowed.length && !allowed.includes("*")) {
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(obj, status, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

async function swapcardQuery(env, query, variables) {
  const res = await fetch(SWAPCARD_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": env.SWAPCARD_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Swapcard ${res.status}: ${text.slice(0, 500)}`);
  }
  const body = await res.json();
  if (body.errors) {
    throw new Error("Swapcard GraphQL errors: " + JSON.stringify(body.errors).slice(0, 800));
  }
  return body.data;
}
