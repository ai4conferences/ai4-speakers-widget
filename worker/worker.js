var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var SWAPCARD_ENDPOINT = "https://developer.swapcard.com/event-admin/graphql";
var LEAN_CACHE_TTL = 1800;
var FULL_CACHE_TTL = 3600;
var STALE_FACTOR = 0.8;
var PAGE_SIZE = 500;
var DEFAULT_FEATURED_ORDER_FIELD = "Featured Order";
var GROUPS_QUERY = (
  /* GraphQL */
  `
  query EventGroups($eventId: ID!) {
    event(id: $eventId) {
      id
      groups { id name peopleCount priority isDefault }
    }
  }
`
);
var FIELD_DEFINITIONS_QUERY = (
  /* GraphQL */
  `
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
`
);
var LEAN_PEOPLE_QUERY = (
  /* GraphQL */
  `
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
        biography
        websiteUrl
        socialNetworks { profile type }
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
`
);
var FULL_PEOPLE_QUERY = (
  /* GraphQL */
  `
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
`
);
var worker_default = {
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
  async scheduled(event, env, ctx) {
    try {
      const leanSpeakers = await fetchLeanSpeakers(env);
      await writeLeanCache(env, null, leanSpeakers);
      console.log(`scheduled lean refresh: ${leanSpeakers.length} speakers cached`);
      ctx.waitUntil(
        fetchFullSpeakers(env).then((full) => writeFullCache(env, null, full)).then(() => console.log("scheduled full refresh complete")).catch((err) => console.error("scheduled full refresh failed:", err))
      );
    } catch (err) {
      console.error("scheduled lean refresh failed:", err);
    }
  }
};
async function handleDiagnostics(env, cors) {
  const [groupsData, fieldsData] = await Promise.all([
    swapcardQuery(env, GROUPS_QUERY, { eventId: env.EVENT_ID }),
    swapcardQuery(env, FIELD_DEFINITIONS_QUERY, { eventId: env.EVENT_ID, target: "PEOPLE" })
  ]);
  const groups = groupsData?.event?.groups || [];
  const fields = fieldsData?.event?.fieldDefinitions || [];
  const featuredFieldName = env.FEATURED_ORDER_FIELD || DEFAULT_FEATURED_ORDER_FIELD;
  return json({
    eventId: env.EVENT_ID,
    groups,
    speakerGroupCandidates: groups.filter((g) => /speaker/i.test(g.name || "") || g.isDefault),
    peopleFieldDefinitions: fields,
    featuredOrderFieldName: featuredFieldName,
    featuredOrderFieldFound: fields.find((f) => f.name === featuredFieldName) || null,
    note: "If featuredOrderFieldFound.__typename is not NumberFieldDefinition, adjust the speakers query."
  }, 200, cors);
}
__name(handleDiagnostics, "handleDiagnostics");
function leanCacheKey(env) {
  return `speakers-lean-v1-${env.EVENT_ID}`;
}
__name(leanCacheKey, "leanCacheKey");
function fullCacheKey(env) {
  return new Request(`https://cache.internal/speakers-full-v1?ev=${env.EVENT_ID}`, { method: "GET" });
}
__name(fullCacheKey, "fullCacheKey");
async function writeLeanCache(env, ctx, speakers) {
  const payload = JSON.stringify(speakers);
  const now = Date.now();
  if (env.SPEAKERS_KV) {
    const p = env.SPEAKERS_KV.put(leanCacheKey(env), payload, {
      expirationTtl: LEAN_CACHE_TTL * 4,
      metadata: { cachedAt: now }
    });
    if (ctx) ctx.waitUntil(p);
    else await p;
  }
  const cacheResp = new Response(JSON.stringify({ speakers, cachedAt: now }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${LEAN_CACHE_TTL}`
    }
  });
  const p2 = caches.default.put(`https://cache.internal/speakers-lean-v1?ev=${env.EVENT_ID}`, cacheResp);
  if (ctx) ctx.waitUntil(p2);
  else await p2;
}
__name(writeLeanCache, "writeLeanCache");
async function readLeanCache(env) {
  if (env.SPEAKERS_KV) {
    try {
      const { value, metadata } = await env.SPEAKERS_KV.getWithMetadata(leanCacheKey(env));
      if (value) return { speakers: JSON.parse(value), cachedAt: metadata?.cachedAt || 0 };
    } catch (_) {
    }
  }
  const cached = await caches.default.match(`https://cache.internal/speakers-lean-v1?ev=${env.EVENT_ID}`);
  if (cached) {
    const body = await cached.json();
    return { speakers: body.speakers, cachedAt: body.cachedAt || 0 };
  }
  return null;
}
__name(readLeanCache, "readLeanCache");
async function writeFullCache(env, ctx, speakers) {
  const now = Date.now();
  const cacheResp = new Response(JSON.stringify({ speakers, cachedAt: now }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${FULL_CACHE_TTL}`
    }
  });
  const p = caches.default.put(fullCacheKey(env), cacheResp);
  if (ctx) ctx.waitUntil(p);
  else await p;
}
__name(writeFullCache, "writeFullCache");
async function readFullCache(env) {
  const cached = await caches.default.match(fullCacheKey(env));
  if (!cached) return null;
  const body = await cached.json();
  return { speakers: body.speakers, cachedAt: body.cachedAt || 0 };
}
__name(readFullCache, "readFullCache");
function isStale(cachedAt, ttl) {
  return Date.now() - cachedAt > ttl * STALE_FACTOR * 1e3;
}
__name(isStale, "isStale");
var LEAN_FIELDS = [
  "id",
  "fullName",
  "firstName",
  "lastName",
  "jobTitle",
  "organization",
  "photoUrl",
  "biography",
  "websiteUrl",
  "socials",
  "customFields",
  "featured",
  "featuredOrder"
];
function projectLean(speaker) {
  const lean = {};
  for (const k of LEAN_FIELDS) lean[k] = speaker[k];
  return lean;
}
__name(projectLean, "projectLean");
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
      if (isStale(cached.cachedAt, LEAN_CACHE_TTL)) {
        needsRefresh = true;
      }
    }
  }
  if (!speakers) {
    speakers = await fetchLeanSpeakers(env);
    await writeLeanCache(env, ctx, speakers);
    fromCache = false;
    needsRefresh = false;
  } else if (needsRefresh) {
    ctx.waitUntil(
      fetchLeanSpeakers(env).then((fresh) => writeLeanCache(env, null, fresh)).catch(console.error)
    );
  }
  const payload = JSON.stringify({
    eventId: env.EVENT_ID,
    count: speakers.length,
    speakers: speakers.map(projectLean),
    generatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  return new Response(payload, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "X-Cache": fromCache ? needsRefresh ? "STALE" : "HIT" : "MISS",
      "Cache-Control": `public, max-age=${LEAN_CACHE_TTL}`
    }
  });
}
__name(handleSpeakersList, "handleSpeakersList");
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
    speakers = await fetchFullSpeakers(env);
    await writeFullCache(env, ctx, speakers);
    fromCache = false;
    needsRefresh = false;
  } else if (needsRefresh) {
    ctx.waitUntil(
      fetchFullSpeakers(env).then((fresh) => writeFullCache(env, null, fresh)).catch(console.error)
    );
  }
  const speaker = speakers.find((s) => s.id === id) || findByCoSpeakerId(speakers, id);
  if (!speaker) {
    return json({ error: "not_found", id }, 404, cors);
  }
  return new Response(JSON.stringify({ speaker }), {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "X-Cache": fromCache ? needsRefresh ? "STALE" : "HIT" : "MISS",
      "Cache-Control": `public, max-age=${FULL_CACHE_TTL}`
    }
  });
}
__name(handleSpeakerDetail, "handleSpeakerDetail");
function findByCoSpeakerId(speakers, communityProfileId) {
  for (const s of speakers) {
    for (const session of s.sessions || []) {
      for (const co of session.speakers || []) {
        if (co.id === communityProfileId && co.fullName) {
          const target = co.fullName.trim().toLowerCase();
          const match = speakers.find(
            (sp) => (sp.fullName || "").trim().toLowerCase() === target
          );
          if (match) return match;
        }
      }
    }
  }
  return null;
}
__name(findByCoSpeakerId, "findByCoSpeakerId");
async function fetchLeanSpeakers(env) {
  return _fetchAllSpeakers(env, LEAN_PEOPLE_QUERY);
}
__name(fetchLeanSpeakers, "fetchLeanSpeakers");
async function fetchFullSpeakers(env) {
  return _fetchAllSpeakers(env, FULL_PEOPLE_QUERY);
}
__name(fetchFullSpeakers, "fetchFullSpeakers");
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
    allPeople.push(...page.nodes || []);
    if (!page.pageInfo?.hasNextPage) break;
    cursor = { first: PAGE_SIZE, after: page.pageInfo.endCursor };
  }
  const speakers = allPeople.filter(
    (p) => (p.groups || []).some((g) => speakerGroupIds.includes(g.id))
  );
  // Normalize then filter out anyone with Widget Visibility = Hidden
  return speakers
    .map((p) => normalizePerson(p, { featuredGroupId, featuredOrderField, eventId: env.EVENT_ID }))
    .filter((p) => {
      const vis = (p.customFields || []).find((f) => f.name === "Widget Visibility");
      if (!vis) return true;
      const vals = vis.values || (vis.value ? [vis.value] : []);
      return !vals.includes("Hidden");
    });
}
__name(_fetchAllSpeakers, "_fetchAllSpeakers");
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
  const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
  const sessionCutoff = Date.now() - SESSION_MAX_AGE_MS;
  const sessions = (p.speakerOnPlannings || []).filter((s) => {
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
  }).map((s) => ({
    id: s.id,
    title: pickEnglish(s.titleTranslations) || "",
    description: pickEnglish(s.descriptionTranslations) || "",
    beginsAt: s.beginsAt || null,
    endsAt: s.endsAt || null,
    bannerUrl: s.bannerUrl || "",
    type: s.type || "",
    speakers: (s.speakers || []).map((sp) => sp.communityProfile).filter(Boolean).map((sp) => ({
      id: sp.id,
      firstName: sp.firstName || "",
      lastName: sp.lastName || "",
      fullName: [sp.firstName, sp.lastName].filter(Boolean).join(" "),
      jobTitle: sp.jobTitle || "",
      organization: sp.organization || "",
      photoUrl: sp.photoUrl || ""
    }))
  }));
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
    featuredOrder
  };
}
__name(normalizePerson, "normalizePerson");
function pickEnglish(translations) {
  if (!Array.isArray(translations) || translations.length === 0) return "";
  const en = translations.find((t) => t.language === "en_US" || t.language === "en");
  if (en) return en.value || en.name || "";
  return translations[0].value || translations[0].name || "";
}
__name(pickEnglish, "pickEnglish");
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
__name(resolveSpeakerGroupIds, "resolveSpeakerGroupIds");
function buildCorsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let allowOrigin = "*";
  if (allowed.length && !allowed.includes("*")) {
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
__name(buildCorsHeaders, "buildCorsHeaders");
function json(obj, status, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...extra }
  });
}
__name(json, "json");
async function swapcardQuery(env, query, variables) {
  const res = await fetch(SWAPCARD_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": env.SWAPCARD_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
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
__name(swapcardQuery, "swapcardQuery");
export {
  worker_default as default
};
