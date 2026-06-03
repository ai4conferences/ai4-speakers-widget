/**
 * Ai4 Speakers Widget — Cloudflare Worker (v6)
 * =============================================
 *
 * Proxies the Swapcard Content API. Holds SWAPCARD_API_KEY as a secret.
 *
 * Endpoints:
 *   GET /speakers       — LEAN list (id, name, title, org, photo, customFields).
 *                         Fetched with a minimal Swapcard query — no bio, sessions,
 *                         or socials. Typically < 3 s cold, ~200 ms warm.
 *   GET /speakers/:id   — FULL record (bio, sessions+co-speakers, socials, website).
 *                         Fetched on-demand when user opens a modal; cached separately.
 *   GET /diagnostics    — Schema discovery: groups + custom field definitions
 *
 * v6 performance improvements over v5:
 *   - TWO Swapcard queries: LEAN_PEOPLE_QUERY (list page, no bio/sessions/socials)
 *     and FULL_PEOPLE_QUERY (detail modal, all fields). The lean fetch is ~10×
 *     smaller and ~10× faster than the old combined query.
 *   - TWO independent caches: lean list (LEAN_CACHE_TTL) and full data
 *     (FULL_CACHE_TTL). Both use stale-while-revalidate so users always get
 *     an instant response from cache; background refresh runs after the response.
 *   - Longer TTLs reduce cold-miss frequency. Cron keeps lean cache warm.
 *   - Optional Workers KV binding (SPEAKERS_KV): if present, lean list is stored
 *     in KV (globally replicated) instead of the regional Cache API, eliminating
 *     per-datacenter cold starts entirely.
 *
 * Setup:
 *   wrangler secret put SWAPCARD_API_KEY --env staging
 *   wrangler deploy --env staging
 */

const SWAPCARD_ENDPOINT = "https://developer.swapcard.com/event-admin/graphql";

// Lean list: how long to serve cached data before a background refresh.
// Cron runs every 5 min so this is effectively always warm.
const LEAN_CACHE_TTL  = 1800;  // 30 min (was 600 s / 10 min)
// Full detail data changes less often; cache for longer.
const FULL_CACHE_TTL  = 3600;  // 1 hour
// Stale-while-revalidate window: if age is within this factor of TTL, serve
// stale immediately and refresh in background.
const STALE_FACTOR    = 0.8;   // refresh when > 80% of TTL has elapsed

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
 * LEAN query — card list only. No bio, sessions, socials, or websiteUrl.
 * Removing speakerOnPlannings alone cuts the Swapcard response by ~10× for
 * events with many sessions. This is the query used for the initial page load.
 */
const LEAN_PEOPLE_QUERY = /* GraphQL */ `
  query EventSpeakersLean($eventId: ID!, $cursor: CursorPaginationInput) {
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
        groups { id name }
        withEvent(eventId: $eventId) {
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

/**
 * FULL query — everything needed for the speaker detail modal.
 * Only fetched by the cron job and on /speakers/:id cache misses.
 * speakerOnPlannings returns the sessions where this person is a speaker.
 * If the schema rejects any fields, hit /diagnostics to introspect.
 */
const FULL_PEOPLE_QUERY = /* GraphQL */ `
  query EventSpeakersFull($eventId: ID!, $cursor: CursorPaginationInput) {
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

  // Cron trigger: keeps caches warm so users never pay cold-fetch latency.
  // Lean refresh is fast (~2-5 s); full refresh runs in background.
  async scheduled(event, env, ctx) {
    try {
      // Always refresh lean cache — this is what the page load uses
      const leanSpeakers = await fetchLeanSpeakers(env);
      await writeLeanCache(env, null, leanSpeakers);
      console.log(`scheduled lean refresh: ${leanSpeakers.length} speakers cached`);

      // Refresh full cache in the background (don't block cron completion)
      ctx.waitUntil(
        fetchFullSpeakers(env)
          .then(full => writeFullCache(env, null, full))
          .then(() => console.log("scheduled full refresh complete"))
          .catch(err => console.error("scheduled full refresh failed:", err))
      );
    } catch (err) {
      console.error("scheduled lean refresh failed:", err);
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
//  Cache helpers — lean list + full detail, independent TTLs
//  ----------------------------------------------------------------
//  Both use stale-while-revalidate: if cached data exists (even if
//  old), return it immediately and kick off a background refresh via
//  ctx.waitUntil(). This means users NEVER wait for a cold Swapcard
//  fetch during normal operation.
//
//  Optional KV: if the SPEAKERS_KV binding is present, lean data is
//  stored there (globally replicated) instead of the regional Cache API.
//  Add to wrangler.toml:
//    [[kv_namespaces]]
//    binding = "SPEAKERS_KV"
//    id = "YOUR_KV_NAMESPACE_ID"
// ============================================================

function leanCacheKey(env) {
  return `speakers-lean-v1-${env.EVENT_ID}`;
}
function fullCacheKey(env) {
  return new Request(`https://cache.internal/speakers-full-v1?ev=${env.EVENT_ID}`, { method: "GET" });
}

/** Write lean list to KV (if available) and Cache API */
async function writeLeanCache(env, ctx, speakers) {
  const payload = JSON.stringify(speakers);
  const now = Date.now();

  // KV: store with metadata timestamp so we can check age on read
  if (env.SPEAKERS_KV) {
    const p = env.SPEAKERS_KV.put(leanCacheKey(env), payload, {
      expirationTtl: LEAN_CACHE_TTL * 4, // let KV keep it 4× longer; we do our own staleness check
      metadata: { cachedAt: now },
    });
    if (ctx) ctx.waitUntil(p); else await p;
  }

  // Cache API fallback (regional)
  const cacheResp = new Response(JSON.stringify({ speakers, cachedAt: now }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${LEAN_CACHE_TTL}`,
    },
  });
  const p2 = caches.default.put(`https://cache.internal/speakers-lean-v1?ev=${env.EVENT_ID}`, cacheResp);
  if (ctx) ctx.waitUntil(p2); else await p2;
}

/** Read lean list. Returns { speakers, cachedAt } or null. */
async function readLeanCache(env) {
  // Try KV first (global)
  if (env.SPEAKERS_KV) {
    try {
      const { value, metadata } = await env.SPEAKERS_KV.getWithMetadata(leanCacheKey(env));
      if (value) return { speakers: JSON.parse(value), cachedAt: metadata?.cachedAt || 0 };
    } catch (_) { /* fall through to Cache API */ }
  }

  // Cache API fallback
  const cached = await caches.default.match(`https://cache.internal/speakers-lean-v1?ev=${env.EVENT_ID}`);
  if (cached) {
    const body = await cached.json();
    return { speakers: body.speakers, cachedAt: body.cachedAt || 0 };
  }
  return null;
}

/** Write full speaker list to Cache API */
async function writeFullCache(env, ctx, speakers) {
  const now = Date.now();
  const cacheResp = new Response(JSON.stringify({ speakers, cachedAt: now }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${FULL_CACHE_TTL}`,
    },
  });
  const p = caches.default.put(fullCacheKey(env), cacheResp);
  if (ctx) ctx.waitUntil(p); else await p;
}

/** Read full speaker list. Returns { speakers, cachedAt } or null. */
async function readFullCache(env) {
  const cached = await caches.default.match(fullCacheKey(env));
  if (!cached) return null;
  const body = await cached.json();
  return { speakers: body.speakers, cachedAt: body.cachedAt || 0 };
}

/** True if cached data is stale enough to warrant a background refresh. */
function isStale(cachedAt, ttl) {
  return (Date.now() - cachedAt) > ttl * STALE_FACTOR * 1000;
}

// ============================================================
//  /speakers + /speakers/:id
// ============================================================

// Fields returned in the lean /speakers list response.
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

async function handleSpeakersList(request, env, ctx, cors) {
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.has("refresh");

  let speakers = null;
  let fromCache = false;
  let needsRefresh = forceRefresh;

  if (!forceRefresh) {
    const cached = await readLeanCache(env);
    if (cached) {
      speakers = cached.speakers;
      fromCache = true;
      // Schedule background refresh if stale, but return immediately
      if (isStale(cached.cachedAt, LEAN_CACHE_TTL)) {
        needsRefresh = true;
      }
    }
  }

  if (!speakers) {
    // Cold miss — must fetch synchronously (user waits, but this should be rare)
    speakers = await fetchLeanSpeakers(env);
    await writeLeanCache(env, ctx, speakers);
    fromCache = false;
    needsRefresh = false;
  } else if (needsRefresh) {
    // Stale-while-revalidate: kick off refresh after responding
    ctx.waitUntil(
      fetchLeanSpeakers(env).then(fresh => writeLeanCache(env, null, fresh)).catch(console.error)
    );
  }

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
      "X-Cache": fromCache ? (needsRefresh ? "STALE" : "HIT") : "MISS",
      "Cache-Control": `public, max-age=${LEAN_CACHE_TTL}`,
    },
  });
}

async function handleSpeakerDetail(id, env, ctx, cors) {
  let speakers = null;
  let fromCache = false;
  let needsRefresh = false;

  const cached = await readFullCache(env);
  if (cached) {
    speakers = cached.speakers;
    fromCache = true;
    if (isStale(cached.cachedAt, FULL_CACHE_TTL)) needsRefresh = true;
  }

  if (!speakers) {
    // Full cache cold — fetch full data now (only happens on first modal open after deploy)
    speakers = await fetchFullSpeakers(env);
    await writeFullCache(env, ctx, speakers);
    fromCache = false;
    needsRefresh = false;
  } else if (needsRefresh) {
    ctx.waitUntil(
      fetchFullSpeakers(env).then(fresh => writeFullCache(env, null, fresh)).catch(console.error)
    );
  }

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
      "X-Cache": fromCache ? (needsRefresh ? "STALE" : "HIT") : "MISS",
      "Cache-Control": `public, max-age=${FULL_CACHE_TTL}`,
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

/** Fetch only card-display fields — used for the /speakers list. Fast. */
async function fetchLeanSpeakers(env) {
  return _fetchAllSpeakers(env, LEAN_PEOPLE_QUERY);
}

/** Fetch all fields including bio/sessions/socials — used for modals. Slow. */
async function fetchFullSpeakers(env) {
  return _fetchAllSpeakers(env, FULL_PEOPLE_QUERY);
}

async function _fetchAllSpeakers(env, query) {
  const speakerGroupIds = await resolveSpeakerGroupIds(env);
  const featuredGroupId = env.FEATURED_GROUP_ID || null;
  const featuredOrderField = env.FEATURED_ORDER_FIELD || DEFAULT_FEATURED_ORDER_FIELD;

  const allPeople = [];
  let cursor = { first: PAGE_SIZE };

  for (let i = 0; i < 50; i++) {
    const data = await swapcardQuery(env, query, { eventId: env.EVENT_ID, cursor });
    const page = data?.eventPerson;
    if (!page) break;
    allPeople.push(...(page.nodes || []));
    if (!page.pageInfo?.hasNextPage) break;
    cursor = { first: PAGE_SIZE, after: page.pageInfo.endCursor };
  }

  // Filter to speakers — anyone in one of the speaker groups
  const speakers = allPeople.filter((p) =>
    (p.groups || []).some((g) => speakerGroupIds.includes(g.id))
  );

  return speakers.map((p) => normalizePerson(p, { featuredGroupId, featuredOrderField, eventId: env.EVENT_ID }));
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
