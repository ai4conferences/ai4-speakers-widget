# Ai4 Speakers Widget

A self-contained speakers directory for the Ai4 conference website. Built with vanilla JS (no framework dependencies) and a Cloudflare Worker that proxies the Swapcard conference API.

## Repo Structure

```
ai4-speakers-widget/
├── speakers-widget.html      ← WordPress embed (drop into a Custom HTML block)
└── worker/
    ├── worker.js             ← Cloudflare Worker source
    └── wrangler.toml         ← Deployment config (fill in your EVENT_ID)
```

---

## Making Changes

### 1 — Clone & edit locally

```bash
git clone https://github.com/YOUR-ORG/ai4-speakers-widget.git
cd ai4-speakers-widget
```

Edit `speakers-widget.html` (styles + JS logic) or `worker/worker.js` (API proxy) in any text editor or VS Code.

### 2 — Push changes to GitHub

```bash
git add .
git commit -m "describe what you changed"
git push
```

### 3 — Deploy the Worker (only needed when worker.js changes)

```bash
cd worker
npm install -g wrangler          # first time only
wrangler login                   # first time only

wrangler deploy --env staging    # test in staging first
wrangler deploy --env production # promote to production
```

### 4 — Update the WordPress embed (only needed when speakers-widget.html changes)

1. In WordPress → Pages → Speakers, find the **Custom HTML** block containing the widget.
2. Replace the entire block contents with the updated `speakers-widget.html`.
3. Make sure the `data-worker-url` attribute still points at your production Worker URL.
4. Update & preview.

---

## First-Time Worker Setup

### Prerequisites
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+ (for Wrangler CLI)
- Swapcard API key

### Steps

```bash
cd worker

# 1. Install Wrangler
npm install -g wrangler

# 2. Log in to Cloudflare
wrangler login

# 3. Fill in your EVENT_ID in wrangler.toml (see [env.staging.vars])

# 4. Set your Swapcard API key as a secret (never in wrangler.toml)
wrangler secret put SWAPCARD_API_KEY --env staging
wrangler secret put SWAPCARD_API_KEY --env production

# 5. Optional: set additional env vars if needed
#    wrangler secret put SPEAKER_GROUP_IDS --env production

# 6. Deploy
wrangler deploy --env staging
wrangler deploy --env production
```

### Verify the Worker

Hit these URLs in your browser after deploying:

| Endpoint | Purpose |
|---|---|
| `https://ai4-speakers.YOUR-SUBDOMAIN.workers.dev/diagnostics` | Inspect Swapcard schema & group IDs |
| `https://ai4-speakers.YOUR-SUBDOMAIN.workers.dev/speakers` | Lean speaker list (used by widget) |
| `https://ai4-speakers.YOUR-SUBDOMAIN.workers.dev/speakers/SPEAKER_ID` | Full speaker detail |

---

## Worker Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SWAPCARD_API_KEY` | ✅ | Set as a **secret** via `wrangler secret put` |
| `EVENT_ID` | ✅ | Swapcard event ID (in `wrangler.toml`) |
| `SPEAKER_GROUP_IDS` | Optional | Comma-separated Swapcard group IDs. Auto-detected if omitted. |
| `FEATURED_GROUP_ID` | Optional | Group ID whose members are shown first |
| `FEATURED_ORDER_FIELD` | Optional | Custom field name for sort order (default: `"Featured Order"`) |
| `ALLOWED_ORIGINS` | Optional | CORS whitelist, e.g. `https://ai4.io,https://www.ai4.io` |

---

## Widget Configuration (speakers-widget.html)

Near the top of the `<script>` block there are several constants you can adjust without touching the rest of the code:

```js
const VISIBLE_FILTERS   = ['Track', 'Industry', 'Job Function'];  // filter dropdowns to show
const INFO_FIELDS       = ['Industry', 'Job Function', 'Company Size']; // fields in speaker modal
const BIO_CLAMP_THRESHOLD = 320;   // chars before "See more" appears
const RENDER_BATCH_SIZE   = 60;    // cards per progressive-render frame
```

The `data-worker-url` attribute on `#ai4-speakers-root` controls which Worker the widget calls:

```html
<div id="ai4-speakers-root"
     data-worker-url="https://ai4-speakers.YOUR-SUBDOMAIN.workers.dev/speakers">
```

---

## Changelog

| Version | Notes |
|---|---|
| v4 | **Mobile fix** — corrected CSS specificity bug that caused 5-column layout on phones. Now shows 2 columns on all screens ≤ 720 px. |
| v3 | Initial production release |
| Worker v5 | Split lean-list + per-speaker-detail endpoints; edge caching; cron warm-up |
