// seo.js — server-side rendering of the speakers directory on ai4.com
// =====================================================================
// When this Worker is routed on the site itself (e.g. ai4.com/speakers*),
// requests for the speakers pages come here instead of going straight to
// WordPress. We fetch the real WordPress page and, as it streams through,
// inject real HTML for every speaker using HTMLRewriter. The widget JS then
// takes over the cards that are already on the page ("hydration").
//
// Everyone — people, Google, LLM crawlers — gets the SAME HTML. No bot
// sniffing (that would be cloaking).
//
// Routes (relative to SPEAKERS_PATH, default "/speakers/"):
//   /speakers/               → WordPress page + injected speaker cards + JSON-LD
//   /speakers/<slug>/        → WordPress page as a shell, widget swapped for a
//                              full static speaker profile (own title/canonical/meta)
//   /speakers/sitemap.xml    → sitemap of all speaker profile URLs
//   /speakers.md             → plain-markdown speaker directory for LLMs
// Anything else under the route (or any failure) passes through to WordPress
// untouched, so the worst case is exactly today's behaviour.

const SLUG_CACHE = new WeakMap();

// ---------- entry points ----------

// SITE_HOSTS is a comma list of hostnames. An entry ending in ".*" matches
// by prefix, e.g. "ai4-speakers-staging.*" matches the staging workers.dev host.
export function isSiteRequest(url, env) {
  const host = url.hostname.toLowerCase();
  const hosts = (env.SITE_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return hosts.some((h) => (h.endsWith(".*") ? host.startsWith(h.slice(0, -1)) : host === h));
}

/**
 * @param data  loaders injected from worker.js:
 *   loadLean(env, ctx, { allowCold }) → Promise<{ speakers, cachedAt } | null>
 *   loadFull(env, ctx, { allowCold }) → Promise<{ speakers, cachedAt } | null>
 */
export async function handleSite(request, env, ctx, data) {
  const res = await routeSite(request, env, ctx, data);
  if (env.NOINDEX !== "true") return res;
  // Staging/preview: keep search engines out.
  const out = new Response(res.body, res);
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}

async function routeSite(request, env, ctx, data) {
  if (request.method !== "GET" && request.method !== "HEAD") return originFetch(request, env);
  const url = new URL(request.url);
  const base = speakersBase(env);
  const path = url.pathname;

  try {
    if (path === base) return await renderListPage(request, env, ctx, data);
    if (path === base + "sitemap.xml") return await renderSitemap(request, env, ctx, data);
    if (path === base.replace(/\/$/, "") + ".md") return await renderMarkdown(request, env, ctx, data);

    if (path.startsWith(base)) {
      const m = path.slice(base.length).match(/^([a-z0-9-]+)(\/?)$/);
      if (m) {
        const res = await renderSpeakerPage(request, env, ctx, data, m[1], m[2] === "/");
        if (res) return res;
      }
    }
  } catch (err) {
    console.error("[seo] render failed, passing through:", err && err.stack || err);
  }
  return originFetch(request, env);
}

// ---------- slugs ----------

export function slugify(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "speaker";
}

/**
 * Adds a stable `slug` to each speaker. Name-based; on a name collision the
 * speaker with the lowest id keeps the plain slug and the others get a short
 * id suffix. Returns the same array (memoized per array instance).
 */
export function withSlugs(speakers) {
  if (!Array.isArray(speakers)) return speakers;
  if (SLUG_CACHE.has(speakers)) return speakers;
  const groups = new Map();
  for (const s of speakers) {
    const base = slugify(s.fullName || [s.firstName, s.lastName].filter(Boolean).join(" "));
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(s);
  }
  for (const [base, list] of groups) {
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    list.forEach((s, i) => {
      s.slug = i === 0 ? base : `${base}-${slugify(String(s.id)).slice(-6)}`;
    });
  }
  SLUG_CACHE.set(speakers, true);
  return speakers;
}

// ---------- list page ----------

async function renderListPage(request, env, ctx, data) {
  const lean = await data.loadLean(env, ctx, { allowCold: false });
  // Never make a page view wait on Swapcard: if the cache is cold, serve
  // WordPress as-is (widget still works client-side) and warm in background.
  if (!lean || !lean.speakers || !lean.speakers.length) return tag(await originFetch(request, env), "bypass-cold");

  const origin = await originFetch(request, env);
  if (!origin.ok || !isHtml(origin)) return origin;

  const base = speakersBase(env);
  const siteOrigin = siteOriginFor(request, env);
  const speakers = sortFeatured(withSlugs(lean.speakers.slice()));
  const cardsHtml = speakers.map((s, i) => cardHtml(s, base, i)).join("");
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${eventLabel(env)} Speakers`,
    numberOfItems: speakers.length,
    itemListElement: speakers.map((s, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: siteOrigin + base + s.slug + "/",
      name: s.fullName,
    })),
  };

  let sawGrid = false;
  const rewriter = new HTMLRewriter()
    .on("#a4s-grid", {
      element(el) {
        sawGrid = true;
        el.setAttribute("data-ssr", String(speakers.length));
        el.removeAttribute("role");
        el.setInnerContent(cardsHtml, { html: true });
      },
    })
    .on("head", {
      element(el) {
        el.append(
          `<link rel="alternate" type="text/markdown" href="${esc(base.replace(/\/$/, "") + ".md")}" title="Speaker directory (markdown)">` +
          ldScript(jsonLd),
          { html: true }
        );
      },
    });

  const out = applyPreview(rewriter, env, data).transform(origin);
  return tag(cleanHeaders(out), "list");
}

function cardHtml(s, base, index) {
  const label = `${s.fullName}${s.jobTitle ? ", " + s.jobTitle : ""}${s.organization ? " at " + s.organization : ""}`;
  const photo = s.photoUrl
    ? `<img src="${esc(s.photoUrl)}" alt="${esc(s.fullName)}" loading="${index < 10 ? "eager" : "lazy"}" decoding="async">`
    : `<div class="a4s-initials">${esc(initials(s))}</div>`;
  return (
    `<a class="a4s-card" href="${esc(base + s.slug + "/")}" data-id="${esc(s.id)}" aria-label="${esc(label)}">` +
      `<div class="a4s-photo">${photo}</div>` +
      `<div class="a4s-text"><h3 class="a4s-name">${esc(s.fullName)}</h3>` +
      (s.jobTitle ? `<p class="a4s-title">${esc(s.jobTitle)}</p>` : "") +
      `</div>` +
      (s.organization ? `<p class="a4s-org">${esc(s.organization)}</p>` : "") +
    `</a>`
  );
}

// Must match the widget's default "featured" sort exactly so hydration can
// reuse the server-rendered cards without re-rendering.
function sortFeatured(list) {
  const ln = (x) => (x.lastName || "").toLowerCase();
  return list.sort((a, b) => {
    if (a.featured && b.featured) {
      const ao = a.featuredOrder ?? Infinity;
      const bo = b.featuredOrder ?? Infinity;
      if (ao !== bo) return ao - bo;
    }
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return ln(a).localeCompare(ln(b));
  });
}

// ---------- speaker page ----------

async function renderSpeakerPage(request, env, ctx, data, slug, hasSlash) {
  const lean = await data.loadLean(env, ctx, { allowCold: true });
  const leanSpeaker = lean && withSlugs(lean.speakers).find((s) => s.slug === slug);
  // Unknown slug → let WordPress handle it (could be a real child page).
  if (!leanSpeaker) return null;

  const base = speakersBase(env);
  const url = new URL(request.url);
  if (!hasSlash) {
    url.pathname = base + slug + "/";
    return Response.redirect(url.toString(), 301);
  }

  const full = await data.loadFull(env, ctx, { allowCold: false });
  const s = (full && full.speakers.find((x) => x.id === leanSpeaker.id)) || leanSpeaker;
  s.slug = leanSpeaker.slug;

  // Use the real /speakers/ WordPress page as the shell so the site header,
  // footer, nav and widget CSS are all there.
  const shellUrl = new URL(base, request.url);
  const headers = new Headers(request.headers);
  ["if-none-match", "if-modified-since", "range"].forEach((h) => headers.delete(h));
  const shell = await originFetch(new Request(shellUrl.toString(), { method: "GET", headers, redirect: "follow" }), env);
  if (!shell.ok || !isHtml(shell)) return null;

  const siteOrigin = siteOriginFor(request, env);
  const canonical = siteOrigin + base + s.slug + "/";
  const title = `${s.fullName} – ${eventLabel(env)} Speaker`;
  const description = metaDescription(s, env);
  const nameToSlug = new Map(withSlugs(lean.speakers).map((x) => [(x.fullName || "").trim().toLowerCase(), x.slug]));
  const profileHtml = await speakerProfileHtml(s, { base, nameToSlug, env });

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url: canonical,
    name: title,
    mainEntity: {
      "@type": "Person",
      name: s.fullName,
      givenName: s.firstName || undefined,
      familyName: s.lastName || undefined,
      jobTitle: s.jobTitle || undefined,
      worksFor: s.organization ? { "@type": "Organization", name: s.organization } : undefined,
      image: s.photoUrl || undefined,
      description: s.biography ? truncate(s.biography.replace(/\s+/g, " "), 500) : undefined,
      url: canonical,
      sameAs: (s.socials || []).map(socialUrl).filter((u) => /^https?:\/\//.test(u)).concat(s.websiteUrl ? [s.websiteUrl] : []),
    },
  };

  const seen = {};
  const setMeta = (key, value) => ({
    element(el) { seen[key] = true; el.setAttribute("content", value); },
  });
  const rewriter = new HTMLRewriter()
    .on("title", { element(el) { seen.title = true; el.setInnerContent(title); } })
    .on('meta[name="description"]', setMeta("description", description))
    .on('meta[property="og:title"]', setMeta("ogTitle", title))
    .on('meta[property="og:description"]', setMeta("ogDescription", description))
    .on('meta[property="og:url"]', setMeta("ogUrl", canonical))
    .on('meta[property="og:type"]', setMeta("ogType", "profile"))
    .on('meta[property="og:image"]', s.photoUrl ? setMeta("ogImage", s.photoUrl) : {})
    .on('meta[name="twitter:title"]', setMeta("twTitle", title))
    .on('meta[name="twitter:description"]', setMeta("twDescription", description))
    .on('meta[name="twitter:image"]', s.photoUrl ? setMeta("twImage", s.photoUrl) : {})
    .on('meta[property="og:image:width"], meta[property="og:image:height"], meta[property="og:image:type"]', { element(el) { if (s.photoUrl) el.remove(); } })
    .on('link[rel="canonical"]', { element(el) { seen.canonical = true; el.setAttribute("href", canonical); } })
    .on('link[rel="shortlink"], link[rel="alternate"][type="application/json"]', { element(el) { el.remove(); } })
    // SEO-plugin schema graphs describe the /speakers/ listing, not this person.
    .on("script.yoast-schema-graph, script.rank-math-schema, script.rank-math-schema-pro", { element(el) { el.remove(); } })
    .on("head", {
      element(el) {
        el.onEndTag((end) => {
          let extra = "";
          if (!seen.title) extra += `<title>${esc(title)}</title>`;
          if (!seen.description) extra += `<meta name="description" content="${esc(description)}">`;
          if (!seen.canonical) extra += `<link rel="canonical" href="${esc(canonical)}">`;
          if (!seen.ogTitle) extra += `<meta property="og:title" content="${esc(title)}">`;
          if (!seen.ogDescription) extra += `<meta property="og:description" content="${esc(description)}">`;
          if (!seen.ogUrl) extra += `<meta property="og:url" content="${esc(canonical)}">`;
          if (!seen.ogType) extra += `<meta property="og:type" content="profile">`;
          if (s.photoUrl && !seen.ogImage) extra += `<meta property="og:image" content="${esc(s.photoUrl)}">`;
          extra += ldScript(jsonLd);
          end.before(extra, { html: true });
        });
      },
    })
    .on("#ai4-speakers-root", {
      element(el) {
        el.setAttribute("data-view", "speaker");
        el.setInnerContent(profileHtml, { html: true });
      },
    });

  const out = cleanHeaders(applyPreview(rewriter, env, data).transform(shell));
  out.headers.delete("link");
  return tag(out, "speaker");
}

async function speakerProfileHtml(s, { base, nameToSlug, env }) {
  const parts = [];
  parts.push(`<nav class="a4s-sp-back"><a href="${esc(base)}">← All speakers</a></nav>`);
  parts.push(`<article class="a4s-sp" itemscope itemtype="https://schema.org/Person">`);

  // Header (same classes as the modal so the widget CSS styles it)
  parts.push(`<header class="a4s-mv-header"><div class="a4s-mv-photo">`);
  parts.push(s.photoUrl
    ? `<img src="${esc(s.photoUrl)}" alt="${esc(s.fullName)}" itemprop="image">`
    : `<div class="a4s-initials">${esc(initials(s))}</div>`);
  parts.push(`</div><div>`);
  parts.push(`<h1 class="a4s-mv-name" itemprop="name">${esc(s.fullName)}</h1>`);
  if (s.jobTitle) parts.push(`<p class="a4s-mv-jobtitle" itemprop="jobTitle">${esc(s.jobTitle)}</p>`);
  if (s.organization) parts.push(`<p class="a4s-mv-org" itemprop="worksFor">${esc(s.organization)}</p>`);
  parts.push(`</div></header>`);

  if (s.biography && s.biography.trim()) {
    const paras = s.biography.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
    parts.push(`<section class="a4s-mv-section"><h2 class="a4s-mv-h">About ${esc(s.firstName || s.fullName)}</h2><div class="a4s-mv-bio" itemprop="description">`);
    for (const p of paras) parts.push(`<p>${esc(p.replace(/\n/g, " "))}</p>`);
    parts.push(`</div></section>`);
  }

  const infoFields = (env.INFO_FIELDS || "Track,Industry,Job Function,Company Size").split(",").map((x) => x.trim());
  const rows = infoFields.map((name) => {
    const cf = (s.customFields || []).find((f) => f.name === name);
    return cf && cf.values && cf.values.length ? { name, value: cf.values.join(", ") } : null;
  }).filter(Boolean);
  if (rows.length) {
    parts.push(`<section class="a4s-mv-section"><dl class="a4s-sp-info">`);
    for (const r of rows) parts.push(`<div class="a4s-mv-info-row"><dt class="a4s-mv-info-label">${esc(r.name)}</dt><dd class="a4s-mv-info-value">${esc(r.value)}</dd></div>`);
    parts.push(`</dl></section>`);
  }

  const sessions = s.sessions || [];
  if (sessions.length) {
    parts.push(`<section class="a4s-mv-section"><h2 class="a4s-mv-h">Speaking at ${esc(eventLabel(env))}</h2><div class="a4s-mv-sessions">`);
    for (const sess of sessions) {
      parts.push(`<div class="a4s-mv-session-card a4s-sp-session">`);
      parts.push(`<h3 class="a4s-mv-session-title">${esc(sess.title || "Untitled session")}</h3>`);
      const when = formatSessionTimeFull(sess.beginsAt, sess.endsAt);
      if (when) parts.push(`<p class="a4s-mv-session-meta"><time datetime="${esc(sess.beginsAt)}">${esc(when)}</time>${sess.type ? " · " + esc(formatSessionType(sess.type)) : ""}</p>`);
      if (sess.description && sess.description.trim()) {
        parts.push(`<div class="a4s-sv-description">${await sanitizeHtml(sess.description)}</div>`);
      }
      const co = (sess.speakers || []).filter((c) => (c.fullName || "").trim().toLowerCase() !== (s.fullName || "").trim().toLowerCase());
      if (co.length) {
        parts.push(`<p class="a4s-sp-cospeakers">With `);
        parts.push(co.map((c) => {
          const cs = nameToSlug.get((c.fullName || "").trim().toLowerCase());
          const label = esc(c.fullName) + (c.organization ? ` (${esc(c.organization)})` : "");
          return cs ? `<a href="${esc(base + cs + "/")}">${label}</a>` : label;
        }).join(", "));
        parts.push(`</p>`);
      }
      parts.push(`</div>`);
    }
    parts.push(`</div></section>`);
  }

  const socials = (s.socials || []).filter((x) => x.profile);
  if (socials.length || s.websiteUrl) {
    parts.push(`<section class="a4s-mv-section"><h2 class="a4s-mv-h">Links</h2><ul class="a4s-sp-links">`);
    for (const soc of socials) parts.push(`<li><a href="${esc(socialUrl(soc))}" rel="noopener nofollow" target="_blank" itemprop="sameAs">${esc(friendlySocialName(soc.type))}</a></li>`);
    if (s.websiteUrl) parts.push(`<li><a href="${esc(s.websiteUrl)}" rel="noopener nofollow" target="_blank" itemprop="url">${esc(s.websiteUrl)}</a></li>`);
    parts.push(`</ul></section>`);
  }

  parts.push(`</article>`);
  parts.push(`<style>
    #ai4-speakers-root[data-view="speaker"] { max-width: 820px; padding: 8px 0 48px; }
    #ai4-speakers-root .a4s-sp-back { margin: 0 0 24px; }
    #ai4-speakers-root .a4s-sp-back a, #ai4-speakers-root .a4s-sp a { color: var(--a4-purple-deep); font-weight: 600; text-decoration: none; }
    #ai4-speakers-root .a4s-sp a:hover, #ai4-speakers-root .a4s-sp-back a:hover { text-decoration: underline; }
    #ai4-speakers-root .a4s-sp h1.a4s-mv-name { font-size: 32px !important; }
    #ai4-speakers-root .a4s-sp-info, #ai4-speakers-root .a4s-sp-info dd { margin: 0; }
    #ai4-speakers-root .a4s-sp-info .a4s-mv-info-row { margin: 0 0 14px !important; }
    #ai4-speakers-root .a4s-sp-session { cursor: default; }
    #ai4-speakers-root .a4s-sp-session .a4s-sv-description { margin-top: 10px; }
    #ai4-speakers-root .a4s-sp-cospeakers { margin-top: 10px !important; font-size: 14px; color: var(--a4-text-muted); }
    #ai4-speakers-root .a4s-sp-links { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 18px; }
  </style>`);
  return parts.join("");
}

function metaDescription(s, env) {
  const who = [s.jobTitle, s.organization].filter(Boolean).join(" at ");
  const lead = `${s.fullName}${who ? ", " + who + "," : ""} is a speaker at ${eventLabel(env)}.`;
  const bio = (s.biography || "").replace(/\s+/g, " ").trim();
  return truncate(bio ? `${lead} ${bio}` : lead, 160);
}

// ---------- sitemap & markdown ----------

async function renderSitemap(request, env, ctx, data) {
  const lean = await data.loadLean(env, ctx, { allowCold: true });
  if (!lean) return null;
  const base = speakersBase(env);
  const siteOrigin = siteOriginFor(request, env);
  const lastmod = new Date(lean.cachedAt || Date.now()).toISOString().slice(0, 10);
  const urls = [siteOrigin + base].concat(withSlugs(lean.speakers).map((s) => siteOrigin + base + s.slug + "/"));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n") +
    `\n</urlset>\n`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=1800", "X-Speakers-SSR": "sitemap" },
  });
}

async function renderMarkdown(request, env, ctx, data) {
  const lean = await data.loadLean(env, ctx, { allowCold: true });
  if (!lean) return null;
  const full = await data.loadFull(env, ctx, { allowCold: false });
  const byId = new Map(((full && full.speakers) || []).map((s) => [s.id, s]));
  const base = speakersBase(env);
  const siteOrigin = siteOriginFor(request, env);
  const speakers = sortFeatured(withSlugs(lean.speakers.slice()));
  const out = [];
  out.push(`# ${eventLabel(env)} Speakers`, "");
  out.push(`${speakers.length} speakers. Canonical page: ${siteOrigin + base}. Updated ${new Date(lean.cachedAt || Date.now()).toISOString()}.`, "");
  for (const l of speakers) {
    const s = byId.get(l.id) || l;
    out.push(`## ${s.fullName}`);
    const who = [s.jobTitle, s.organization].filter(Boolean).join(", ");
    if (who) out.push(who);
    out.push(`Profile: ${siteOrigin + base + l.slug}/`);
    for (const cf of s.customFields || []) {
      if (cf.name === "Widget Visibility") continue;
      if (cf.values && cf.values.length) out.push(`${cf.name}: ${cf.values.join(", ")}`);
    }
    for (const sess of s.sessions || []) {
      out.push(`Session: ${sess.title}${sess.beginsAt ? " — " + formatSessionTimeFull(sess.beginsAt, sess.endsAt) : ""}`);
    }
    if (s.biography) out.push("", s.biography.trim());
    out.push("");
  }
  return new Response(out.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=1800",
      "Link": `<${siteOrigin + base}>; rel="canonical"`,
      "X-Speakers-SSR": "markdown",
    },
  });
}

// ---------- preview mode (staging only) ----------
// With PREVIEW_WIDGET="true", the staging Worker proxies the LIVE WordPress
// page but swaps the widget's inline <style>/<script> for the version bundled
// with this Worker (speakers-widget.html in this repo), and points the widget
// at this Worker's own API (/api/speakers). That lets you test new widget JS
// + SSR together without touching WordPress or production.
function applyPreview(rewriter, env, data) {
  if (env.PREVIEW_WIDGET !== "true" || !data.widgetSource) return rewriter;
  const src = data.widgetSource;
  const style = (src.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  const script = (src.match(/<script>[\s\S]*?<\/script>/) || [""])[0];
  const apiUrl = env.PREVIEW_API_URL || "/api/speakers";
  let seenRoot = false;
  let swapped = false;
  return rewriter
    .on("#ai4-speakers-root", {
      element(el) { seenRoot = true; el.setAttribute("data-worker-url", apiUrl); },
    })
    .on("script", {
      element(el) {
        // The first inline script after the widget root is the widget's own.
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (!seenRoot || swapped || el.getAttribute("src")) return;
        if (type && !/javascript|ecmascript|^module$/.test(type)) return;
        swapped = true;
        el.replace(style + script, { html: true });
      },
    });
}

// ---------- helpers ----------

function speakersBase(env) {
  let p = env.SPEAKERS_PATH || "/speakers/";
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.endsWith("/")) p += "/";
  return p;
}
function eventLabel(env) { return env.EVENT_LABEL || "Ai4"; }
function siteOriginFor(request, env) { return (env.SITE_ORIGIN || new URL(request.url).origin).replace(/\/$/, ""); }

// In production this is just fetch(request): a Worker's subrequest to its own
// zone goes to the origin (WordPress), not back into the Worker.
// ORIGIN_OVERRIDE exists only for local testing with `wrangler dev`.
function originFetch(request, env) {
  if (env.ORIGIN_OVERRIDE) {
    const u = new URL(request.url);
    const o = new URL(env.ORIGIN_OVERRIDE);
    u.protocol = o.protocol; u.host = o.host;
    return fetch(new Request(u.toString(), request));
  }
  return fetch(request);
}

function isHtml(res) { return (res.headers.get("content-type") || "").includes("text/html"); }

function cleanHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.delete("etag");
  out.headers.delete("last-modified");
  out.headers.delete("content-length");
  return out;
}
function tag(res, value) {
  const out = new Response(res.body, res);
  out.headers.set("X-Speakers-SSR", value);
  return out;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function ldScript(obj) {
  // Escape "<" so a bio containing "</script>" can't break out.
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}
function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)).replace(/[\s,.;:]+$/, "") + "…";
}
function initials(s) { return (((s.firstName || "").charAt(0) + (s.lastName || "").charAt(0)).toUpperCase()) || "?"; }

function socialUrl(soc) {
  const p = soc.profile || "";
  if (/^https?:\/\//i.test(p)) return p;
  switch (soc.type) {
    case "LINKEDIN": return "https://linkedin.com/in/" + p;
    case "TWITTER": return "https://twitter.com/" + p.replace(/^@/, "");
    case "X": return "https://x.com/" + p.replace(/^@/, "");
    case "FACEBOOK": return "https://facebook.com/" + p;
    case "INSTAGRAM": return "https://instagram.com/" + p.replace(/^@/, "");
    default: return p;
  }
}
function friendlySocialName(type) {
  if (type === "LINKEDIN") return "LinkedIn";
  return type ? type.charAt(0) + type.slice(1).toLowerCase() : "Link";
}
function formatSessionType(type) {
  return String(type || "").split(/[_\s]+/).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}

// Session times: same logic as the widget. Swapcard returns naive venue-local
// strings (no offset), which we display as-is in Pacific.
const DISPLAY_TIMEZONE = "America/Los_Angeles";
const DISPLAY_TIMEZONE_LABEL = "PT";
function getDisplayDate(iso) {
  if (!iso) return null;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(iso)) return { date: new Date(iso), tz: DISPLAY_TIMEZONE };
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))), tz: "UTC" };
}
function formatSessionTimeFull(beginsAt, endsAt) {
  try {
    const start = getDisplayDate(beginsAt);
    if (!start) return "";
    const dateStr = start.date.toLocaleDateString("en-US", { timeZone: start.tz, weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const startTime = start.date.toLocaleTimeString("en-US", { timeZone: start.tz, hour: "numeric", minute: "2-digit" });
    const end = getDisplayDate(endsAt);
    if (!end) return `${dateStr}, ${startTime} ${DISPLAY_TIMEZONE_LABEL}`;
    const endTime = end.date.toLocaleTimeString("en-US", { timeZone: end.tz, hour: "numeric", minute: "2-digit" });
    return `${dateStr}, ${startTime} – ${endTime} ${DISPLAY_TIMEZONE_LABEL}`;
  } catch { return ""; }
}

// Allow-list sanitizer for Swapcard session descriptions (HTML).
async function sanitizeHtml(html) {
  const ALLOWED = new Set(["p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "a"]);
  const DROP = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "base", "link", "meta", "noscript", "template", "svg", "math", "head", "title"]);
  const rw = new HTMLRewriter()
    .on("*", {
      element(el) {
        const t = el.tagName.toLowerCase();
        if (DROP.has(t)) { el.remove(); return; }
        if (!ALLOWED.has(t)) { el.removeAndKeepContent(); return; }
        const href = t === "a" ? (el.getAttribute("href") || "").trim() : "";
        for (const [name] of [...el.attributes]) el.removeAttribute(name);
        if (t === "a") {
          if (/^https?:\/\//i.test(href)) {
            el.setAttribute("href", href);
            el.setAttribute("rel", "noopener nofollow");
            el.setAttribute("target", "_blank");
          } else {
            el.removeAndKeepContent();
          }
        }
      },
    })
    .onDocument({ comments(c) { c.remove(); } });
  return rw.transform(new Response(String(html), { headers: { "content-type": "text/html" } })).text();
}
