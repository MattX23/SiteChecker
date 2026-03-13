# Site Checker

A locally-run audit tool for BlueBayTravel's nav bar. Crawls a site's navigation, validates every link, and checks each destination page for content completeness — hero image, tagline, and about section.

Built as an internal PoC for auditing [Blue Bay Travel](https://bluebaytravel.co.uk), [Tropical Warehouse](https://tropicalwarehouse.co.uk), and [Caribbean Warehouse](https://caribbeanwarehouse.co.uk).

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Express](https://img.shields.io/badge/Express-4-lightgrey) ![Puppeteer](https://img.shields.io/badge/Puppeteer-Core-blue)

---

## Screenshots

<img width="970" height="921" alt="Screenshot 2026-03-11 at 13 40 16" src="https://github.com/user-attachments/assets/75b258fd-39af-4eda-8e94-bc64ad7730d3" />

---

## What it checks

For every link found in the site's navigation:

| Check | Pass | Warn | Fail |
|---|---|---|---|
| **Nav link** | Lands on a valid `/holidays/` path | Redirected to unexpected path | Dead link (4xx/5xx) or redirected to homepage |
| **Hero image** | `.country-hero--image` present | — | Element missing (country pages only; region pages are exempt) |
| **Hero tagline** | Present, ends on a real word | Ends on a preposition / bare boilerplate / duplicate `££` symbol | Element missing or empty |
| **About section** | 100+ words (excl. boilerplate) | Under 100 words | Section missing |
| **Page size** | Within 2× average payload | — | Exceeds 2× average payload |

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js |
| Server | Express |
| Browser automation | Puppeteer Core + Google Chrome |
| HTML parsing | Cheerio |
| Streaming | Server-Sent Events (SSE) |
| Persistence | JSON files in `/data/` |
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

> Add `/data/` to your `.gitignore` — this folder is created automatically and holds persisted audit results.

---

## Usage

Select a site tab and click **Run Audit**. Results stream in real time as each link is checked. Previous audit results load automatically when switching tabs — no need to re-run if you just want to review.

Only one crawl can run at a time. While a crawl is in progress, other site tabs are dimmed and disabled.

The progress log is per-tab — switching tabs shows that tab's own log.

### Filters

Use the filter bar to narrow results:

- **All** — every nav link
- **Issues only** — any card with at least one problem
- **Nav problems** — dead links or wrong destinations
- **Hero problems** — missing or incomplete tagline
- **About problems** — missing or thin content
- **Large pages** — pages exceeding 2× the average payload, with the threshold shown inline

### Summary bar

Shows counts for: Nav OK, Dead Links, Wrong Destination, Hero Issues, About Issues, and Avg Page Size.

### Downloading a report

Once an audit completes, a **Download Report** button appears. This downloads a self-contained HTML file containing all pages with issues and any large pages, with full detail per entry. Open it in a browser and use **Print → Save as PDF** to share with others.

---

## Project structure

```
sitechecker/
├── server.js          # Express backend — Puppeteer crawl, SSE streaming, content checks, report generation
├── package.json
├── data/              # Auto-created. Persisted audit results per site (gitignore this)
└── public/
    └── index.html     # Frontend UI — vanilla JS, SSE client, real-time rendering
```

---

## How it works

1. Puppeteer launches a headless Chrome instance and loads the target homepage
2. Cheerio parses the rendered HTML and extracts all nav links from `.cd-secondary-nav` (supports two nav structures used across the three sites)
3. Each link is fetched in the browser (pages are JS-rendered; plain HTTP requests return a shell)
4. Before capturing HTML, Puppeteer waits for the hero price (`£`) to hydrate — avoiding false positives on slow-loading availability data
5. Results stream to the frontend via SSE as each link completes
6. After all links are checked, average page payload is computed and any page exceeding 2× that average is flagged
7. The completed result is persisted to `/data/{hostname}.json` and loaded automatically on future visits
8. The about section word count strips the boilerplate "Speak to an Expert" block before counting

---

## Notes

- Crawls are sequential — each page opens in a new browser tab within a single Chrome instance. Expect 3–5 minutes for a nav with 90+ links.
- Sister-site links (e.g. Tropical Warehouse links appearing in Caribbean Warehouse's nav) are fully checked for content, not just liveness.
- `/brands/`, `/collections/`, `/blog/` and other non-holiday links are checked for liveness only — no content checks are run on them.
- Region pages (`/holidays/{country}/{region}`) are exempt from the hero image check — they don't have one by design.
- The hero tagline check does not require a price — "Explore holidays to Malta" is valid. It only flags taglines that end on a dangling preposition (e.g. "Explore holidays to Malta from"), are bare boilerplate with no destination, or contain a duplicate `££` symbol indicating a template rendering error.
- Large page flags are computed after all pages are checked (the average can only be known at the end) and are patched into already-rendered cards via a follow-up SSE event.
