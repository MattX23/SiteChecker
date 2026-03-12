const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function siteKey(url) {
  try { return new URL(url).hostname.replace(/[^a-z0-9]/gi, '_'); }
  catch { return 'unknown'; }
}
function saveResult(siteUrl, payload) {
  const file = path.join(DATA_DIR, `${siteKey(siteUrl)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}
function loadResult(siteUrl) {
  const file = path.join(DATA_DIR, `${siteKey(siteUrl)}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const ABOUT_MIN_WORDS = 100;
const TIMEOUT = 15000;

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

const SISTER_SITES = [
  'bluebaytravel.co.uk',
  'tropicalwarehouse.co.uk',
  'caribbeanwarehouse.co.uk',
];

async function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const http = axios.create({
  timeout: TIMEOUT,
  validateStatus: () => true,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; SiteChecker/1.0)',
    'Accept': 'text/html,application/xhtml+xml',
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function normaliseUrl(input) {
  input = input.trim();
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
  return input.replace(/\/$/, '');
}

function stripTrailingQuery(url) {
  return url.replace(/\?$/, '');
}

function isHolidayPath(pathname) {
  return /^\/holidays\/[^/]+(\/[^/]+)?$/.test(pathname);
}

function isRegionPath(url) {
  try {
    const p = new URL(url).pathname;
    return /^\/holidays\/[^/]+\/[^/]+/.test(p);
  } catch { return false; }
}

function isSisterSite(hostname) {
  return SISTER_SITES.some(s => hostname === s || hostname.endsWith('.' + s));
}

// ── Nav extraction ────────────────────────────────────────────────────────────
function extractNavLinks($, baseUrl) {
  const navLinks = [];
  const seen = new Set();

  function addLink(href, text) {
    if (!href || href === '#' || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const abs = stripTrailingQuery(new URL(href, baseUrl).href);
      if (seen.has(abs)) return;
      seen.add(abs);
      navLinks.push({ href: abs, text: text.trim().replace(/\s+/g, ' ') });
    } catch { /* skip invalid */ }
  }

  const structureALinks = $('.cd-secondary-nav .nav-ul a[href]');
  if (structureALinks.length > 0) {
    structureALinks.each((_, el) => addLink($(el).attr('href'), $(el).text()));
    return { links: navLinks, structure: 'A' };
  }

  const structureBLinks = $('.cd-secondary-nav a.item--link[href]');
  if (structureBLinks.length > 0) {
    structureBLinks.each((_, el) => addLink($(el).attr('href'), $(el).text()));
    return { links: navLinks, structure: 'B' };
  }

  $('.cd-secondary-nav a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('/holidays/') || href.includes('/collections/')) {
      addLink(href, $(el).text());
    }
  });
  return { links: navLinks, structure: 'fallback' };
}

// ── Fetching ──────────────────────────────────────────────────────────────────
async function fetchPage(url) {
  try {
    const resp = await http.get(url);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      finalUrl: resp.request?.res?.responseUrl || url,
      html: typeof resp.data === 'string' ? resp.data : null,
    };
  } catch (err) {
    return { ok: false, status: null, error: err.message, html: null };
  }
}

async function fetchWithPage(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    try {
      await page.waitForFunction(
          () => {
            const el = document.querySelector('.hero-heading--beta');
            return el && el.textContent.includes('£');
          },
          { timeout: 5000 }
      );
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
    const html = await page.content();
    const finalUrl = page.url();
    const payloadBytes = Buffer.byteLength(html, 'utf8');
    return { ok: true, status: response?.status() || 200, finalUrl, html, payloadBytes };
  } catch (err) {
    return { ok: false, status: null, error: err.message, html: null, payloadBytes: null };
  } finally {
    await page.close();
  }
}

// ── Content checks ────────────────────────────────────────────────────────────
function checkHeroText(text) {
  const clean = text.trim().replace(/\s+/g, ' ');
  const endsOnPrep = /\b(to|in|for|from|of|and|the|a|an)\s*$/i.test(clean);
  const hasPrice = clean.includes('£');
  const explorePattern = /^explore holidays to\s*$/i.test(clean);

  if (explorePattern) return { status: 'incomplete', issue: 'Destination name is missing from tagline' };
  if (!hasPrice) return { status: 'incomplete', issue: 'No price found — tagline may be cut off' };
  if (endsOnPrep) return { status: 'incomplete', issue: `Tagline ends abruptly: "${clean}"` };
  return { status: 'ok', issue: null };
}

function checkPage(url, html) {
  const $ = cheerio.load(html);
  const result = { url, hero: null, heroImage: null, about: null };

  if (isRegionPath(url)) {
    result.heroImage = { status: 'n/a' };
  } else {
    const heroImageEl = $('.country-hero--image').first();
    const heroImageSrc = heroImageEl.attr('src') || null;
    result.heroImage = heroImageSrc
        ? { status: 'ok', src: heroImageSrc }
        : { status: 'missing' };
  }

  const heroEl = $('.hero-heading--beta').first();
  if (!heroEl.length) {
    result.hero = { status: 'missing', text: null };
  } else {
    const text = heroEl.text().trim().replace(/\s+/g, ' ');
    if (!text) {
      result.hero = { status: 'empty', text: null };
    } else {
      const check = checkHeroText(text);
      result.hero = { status: check.status, text, issue: check.issue };
    }
  }

  const aboutEl = $('#about').first();
  if (!aboutEl.length) {
    result.about = { status: 'missing', wordCount: 0, text: null };
  } else {
    aboutEl.find('.country-cta').remove();
    const text = aboutEl.text().trim().replace(/\s+/g, ' ');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    result.about = wordCount < ABOUT_MIN_WORDS
        ? { status: 'short', wordCount, text: text.slice(0, 200) }
        : { status: 'ok', wordCount, text: text.slice(0, 200) };
  }

  return result;
}

// ── Stored results endpoint ───────────────────────────────────────────────────
app.get('/api/results', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  const data = loadResult(url);
  if (!data) return res.status(404).json({ error: 'No stored result' });
  res.json(data);
});

// ── Debug endpoint ────────────────────────────────────────────────────────────
app.post('/api/debug', async (req, res) => {
  const { url } = req.body;
  const baseUrl = normaliseUrl(url || 'https://tropicalwarehouse.co.uk');
  const executablePath = await findChrome();
  if (!executablePath) return res.json({ error: 'Chrome not found' });

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const result = await fetchWithPage(browser, baseUrl);
    if (!result.html) return res.json({ error: 'No HTML returned', details: result });

    const $ = cheerio.load(result.html);
    const { links, structure } = extractNavLinks($, baseUrl);
    const navHtml = $('.cd-secondary-nav').html();

    res.json({
      structure,
      linksFound: links.length,
      sampleLinks: links.slice(0, 5),
      htmlLength: result.html.length,
      finalUrl: result.finalUrl,
      navSample: navHtml ? navHtml.slice(0, 2000) : null,
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ── Crawl endpoint ────────────────────────────────────────────────────────────
app.post('/api/crawl', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const baseUrl = normaliseUrl(url);
  const baseHost = new URL(baseUrl).hostname;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const executablePath = await findChrome();
  if (!executablePath) {
    send({ type: 'error', message: 'Google Chrome not found. Please install it.' });
    res.end();
    return;
  }

  send({ type: 'status', message: 'Launching browser…' });

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    send({ type: 'status', message: 'Fetching homepage (rendering JavaScript)…' });

    const home = await fetchWithPage(browser, baseUrl);
    if (!home.ok || !home.html) {
      send({ type: 'error', message: `Could not load ${baseUrl} — ${home.status || home.error}` });
      return;
    }

    const $ = cheerio.load(home.html);
    const { links: navLinks, structure } = extractNavLinks($, baseUrl);

    send({ type: 'status', message: `Page loaded (${home.html.length} bytes). Nav structure: ${structure}. Found ${navLinks.length} unique links.` });

    if (navLinks.length === 0) {
      send({ type: 'error', message: 'No nav links found. Run /api/debug to inspect the page structure.' });
      return;
    }

    send({ type: 'status', message: `Checking ${navLinks.length} links…` });

    const results = [];

    for (const link of navLinks) {
      send({ type: 'progress', message: `Checking: ${link.text}` });

      const resp = await fetchWithPage(browser, link.href);
      const finalUrl = stripTrailingQuery(resp.finalUrl || link.href);

      let finalParsed;
      try { finalParsed = new URL(finalUrl); } catch { finalParsed = null; }

      const entry = {
        linkText: link.text,
        originalHref: link.href,
        finalUrl,
        status: resp.status,
        ok: resp.ok,
        error: resp.error || null,
        redirected: !!(resp.finalUrl && stripTrailingQuery(resp.finalUrl) !== link.href),
        payloadBytes: resp.payloadBytes || null,
        navCheck: null,
        linkType: null,
        hero: null,
        about: null,
      };

      if (finalParsed) {
        const onBaseSite = finalParsed.hostname === baseHost;
        const onSister = isSisterSite(finalParsed.hostname);
        if (onBaseSite && isHolidayPath(finalParsed.pathname)) {
          entry.linkType = 'holiday';
        } else if (onSister && !onBaseSite && isHolidayPath(finalParsed.pathname)) {
          entry.linkType = 'sister-holiday';
        } else if (finalParsed.pathname.startsWith('/collections')) {
          entry.linkType = 'collection';
        } else {
          entry.linkType = 'other';
        }
      }

      if (!resp.ok) {
        entry.navCheck = 'dead';
      } else if (!finalParsed) {
        entry.navCheck = 'error';
      } else {
        const onHolidayPath = isHolidayPath(finalParsed.pathname);
        const origParsed = (() => { try { return new URL(link.href); } catch { return null; } })();
        const origPath = origParsed ? origParsed.pathname : null;
        const origWasHoliday = origPath && isHolidayPath(origPath);
        const redirectedToHomepage = finalParsed.pathname === '/';

        if (origWasHoliday && !onHolidayPath) {
          entry.navCheck = 'wrong_path';
        } else if (redirectedToHomepage) {
          entry.navCheck = 'wrong_path';
        } else {
          entry.navCheck = 'ok';
        }

        if ((entry.linkType === 'holiday' || entry.linkType === 'sister-holiday') && resp.html) {
          const pageCheck = checkPage(entry.finalUrl, resp.html);
          entry.heroImage = pageCheck.heroImage;
          entry.hero = pageCheck.hero;
          entry.about = pageCheck.about;
        }
      }

      results.push(entry);
      send({ type: 'result', result: entry });
    }

    // Compute average payload and flag outliers (> 2× average)
    const payloads = results.map(r => r.payloadBytes).filter(Boolean);
    const avgPayload = payloads.length
        ? Math.round(payloads.reduce((a, b) => a + b, 0) / payloads.length)
        : 0;
    results.forEach(r => {
      if (r.payloadBytes && avgPayload > 0 && r.payloadBytes > avgPayload * 2) r.payloadLarge = true;
      r.avgPayloadBytes = avgPayload;
    });

    const summary = {
      total: results.length,
      navOk: results.filter(r => r.navCheck === 'ok').length,
      navDead: results.filter(r => r.navCheck === 'dead').length,
      navWrongPath: results.filter(r => r.navCheck === 'wrong_path').length,
      heroIssues: results.filter(r => r.hero && r.hero.status !== 'ok').length,
      aboutIssues: results.filter(r => r.about && r.about.status !== 'ok').length,
      avgPayloadBytes: avgPayload,
    };

    saveResult(baseUrl, { url: baseUrl, crawledAt: new Date().toISOString(), summary, results });

    send({ type: 'done', summary });

  } catch (err) {
    send({ type: 'error', message: `Unexpected error: ${err.message}` });
  } finally {
    if (browser) await browser.close();
    res.end();
  }
});

const PORT = 3333;
app.listen(PORT, () => {
  console.log(`\n✅ Site Checker running at http://localhost:${PORT}\n`);
});
