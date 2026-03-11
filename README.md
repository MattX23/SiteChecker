# Site Checker — Blue Bay Travel PoC

Audits nav links, hero taglines, and about section content across the three Blue Bay Travel sites.

## Setup

```bash
npm install
```

## Run

```bash
node server.js
```

Then open **http://localhost:3333** in your browser.

## What it checks

### Nav links (`.cd-secondary-nav .nav-ul`)
Each link must resolve to a `/holidays/{country}` or `/holidays/{country}/{region}` path on the **same domain**. Flags:
- Dead links (4xx, 5xx, timeouts)
- Wrong destination (redirected to homepage, different domain, etc.)
- Wrong path (anything not matching the expected pattern)

### Hero tagline (`.hero-heading--beta`)
- Missing: element not present on the page
- Empty: element exists but contains no text

### About section (`#about`)
- Missing: element not present
- Too short: under 100 words

## Sites

- bluebaytravel.co.uk
- tropicalwarehouse.co.uk
- caribbeanwarehouse.co.uk

## Next steps (post-PoC)

- AI-powered overview quality scoring (OpenAI / Claude)
- Scheduled runs with email/Slack reports
- Export results to CSV
