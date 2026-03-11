# Site Checker

A locally-run audit tool for travel websites. Crawls a site's navigation, validates every link, and checks each destination page for content completeness — hero image, tagline, and about section.

Built as an internal PoC for auditing [Blue Bay Travel](https://bluebaytravel.co.uk), [Tropical Warehouse](https://tropicalwarehouse.co.uk), and [Caribbean Warehouse](https://caribbeanwarehouse.co.uk).

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Express](https://img.shields.io/badge/Express-4-lightgrey) ![Puppeteer](https://img.shields.io/badge/Puppeteer-Core-blue)

---

## What it checks

For every link found in a site's navigation:

| Check | Pass | Warn | Fail |
|---|---|---|---|
| **Nav link** | Lands on a valid `/holidays/` path | Redirected to unexpected path | Dead link (4xx/5xx) or redirected to homepage |
| **Hero image** | `.country-hero--image` present | — | Element missing |
| **Hero tagline** | Present with destination name and price | No price / ends abruptly | Element missing or empty |
| **About section** | 100+ words (excl. boilerplate) | Under 100 words | Section missing |

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js |
| Server | Express |
| Browser automation | Puppeteer Core + Google Chrome |
| HTML parsing | Cheerio |
| Streaming | Server-Sent Events (SSE) |
| Frontend | Vanilla HTML/CSS/JS (single file, no build step) |

---

## Requirements

- Node.js 18+
- Google Chrome installed locally (Puppeteer Core uses your system Chrome)

---

## Setup

```bash
git clone <repo-url>
cd sitechecker
npm install
node server.js
```

Then open [http://localhost:3333](http://localhost:3333).

---

## Usage

Enter a site URL or use one of the quick-launch buttons. The audit streams results in real time as each link is checked.

The progress log updates live — once a result is ready, the country/region name becomes a clickable link that jumps directly to its result card.

### Filters

Use the filter bar to narrow results:

- **All** — every nav link
- **Issues only** — any card with at least one problem
- **Nav problems** — dead links or wrong destinations
- **Hero problems** — missing/incomplete tagline
- **About problems** — missing or thin content

### Summary bar

At the top of results, pills show counts for: Nav OK, Dead Links, Wrong Destination, Hero Issues, and About Issues.

---

## Project structure

```
sitechecker/
├── server.js          # Express backend — Puppeteer crawl, SSE streaming, content checks
├── package.json
└── public/
    └── index.html     # Frontend UI — vanilla JS, SSE client, real-time rendering
```

---

## How it works

1. Puppeteer launches a headless Chrome instance and loads the target homepage
2. Cheerio parses the rendered HTML and extracts all nav links from `.cd-secondary-nav` (supports two nav structures used across the three sites)
3. Each link is fetched in the browser (pages are JS-rendered; plain HTTP requests return a shell)
4. Before capturing HTML, Puppeteer waits for the hero price (`£`) to hydrate — avoiding false positives on slow-loading availability data
5. Results are streamed to the frontend via SSE as each link completes
6. The about section word count strips the boilerplate "Speak to an Expert" block before counting

---

## Notes

- Crawls are sequential — each page opens in a new browser tab within a single Chrome instance. Expect 3–5 minutes for a nav with 90+ links.
- Sister-site links (e.g. Tropical Warehouse links appearing in Caribbean Warehouse's nav) are fully checked for content, not just liveness.
- `/brands/`, `/collections/`, `/blog/` and other non-holiday links are checked for liveness only — no content checks are run on them.
