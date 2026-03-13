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

  // Ends on a preposition or article — something was definitely cut off
  // e.g. "Explore holidays to Malta from" or "Explore holidays to"
  const endsOnPrep = /\b(to|in|for|from|of|and|the|a|an)\s*$/i.test(clean);

  // Completely bare — just the boilerplate with nothing meaningful after it
  const bareBoilerplate = /^(explore holidays to|holidays (to|in)|book holidays (to|in))\s*$/i.test(clean);

  if (bareBoilerplate) return { status: 'incomplete', issue: 'Destination name is missing from tagline' };
  if (endsOnPrep) return { status: 'incomplete', issue: `Tagline ends abruptly: "${clean}"` };
  if (clean.includes('££')) return { status: 'incomplete', issue: `Duplicate price symbol — template rendered twice: "${clean}"` };

  // Ends on a real word — treat as ok even without a price.
  // The price is loaded dynamically and may not always hydrate in time.
  // "Explore holidays to Malta" is a valid complete tagline without a price.
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
    results.forEach((r, i) => {
      r.payloadLarge = !!(r.payloadBytes && avgPayload > 0 && r.payloadBytes > avgPayload * 2);
      r.avgPayloadBytes = avgPayload;
      // Notify frontend so it can update the already-rendered card
      if (r.payloadLarge) {
        send({ type: 'payload-update', index: i, payloadBytes: r.payloadBytes, avgPayloadBytes: avgPayload });
      }
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

// ── Email/report HTML builder ─────────────────────────────────────────────────
function buildEmailHtml(data) {
  const s = data.summary;
  const site = new URL(data.url).hostname;
  const date = new Date(data.crawledAt).toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const issueCount = s.navDead + s.navWrongPath + s.heroIssues + s.aboutIssues;

  const issuePages = (data.results || []).filter(r =>
      r.navCheck !== 'ok' ||
      (r.heroImage && r.heroImage.status !== 'ok' && r.heroImage.status !== 'n/a') ||
      (r.hero && r.hero.status !== 'ok') ||
      (r.about && r.about.status !== 'ok')
  );

  const largePages = (data.results || []).filter(r => r.payloadLarge);

  const formatBytes = (b) => {
    if (!b) return '—';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  };

  const pill = (val, colour, label) => `
    <td style="text-align:center;padding:0 16px">
      <div style="font-size:24px;font-weight:600;color:${colour}">${val}</div>
      <div style="font-size:11px;color:#888;margin-top:2px;white-space:nowrap">${label}</div>
    </td>`;

  const tag = (text, colour, bg) =>
      `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;color:${colour};background:${bg};margin:2px 2px 2px 0">${text}</span>`;

  const detailRow = (label, value, valueStyle = '') =>
      `<tr>
      <td style="font-size:11px;color:#888;padding:3px 0;width:120px;vertical-align:top">${label}</td>
      <td style="font-size:12px;color:#444;padding:3px 0;${valueStyle}">${value}</td>
    </tr>`;

  const issueRows = issuePages.map(r => {
    const tags = [];
    if (r.navCheck === 'dead') tags.push(tag('Dead link', '#b93030', '#fdf1f1'));
    if (r.navCheck === 'wrong_path') tags.push(tag('Wrong destination', '#a05c00', '#fef6ec'));
    if (r.heroImage && r.heroImage.status === 'missing') tags.push(tag('Hero image missing', '#b93030', '#fdf1f1'));
    if (r.hero && r.hero.status === 'missing') tags.push(tag('Hero tagline missing', '#b93030', '#fdf1f1'));
    if (r.hero && r.hero.status === 'incomplete') tags.push(tag('Hero tagline incomplete', '#a05c00', '#fef6ec'));
    if (r.hero && r.hero.issue && r.hero.issue.includes('Duplicate price')) tags.push(tag('Double ££ symbol', '#b93030', '#fdf1f1'));
    if (r.about && r.about.status === 'missing') tags.push(tag('About section missing', '#b93030', '#fdf1f1'));
    if (r.about && r.about.status === 'short') tags.push(tag(`About too short (${r.about.wordCount}w)`, '#a05c00', '#fef6ec'));

    const details = [];
    details.push(detailRow('URL', `<a href="${r.originalHref}" style="color:#2a6496">${r.originalHref}</a>`));
    if (r.redirected && r.finalUrl !== r.originalHref) {
      details.push(detailRow('Landed on', `<a href="${r.finalUrl}" style="color:#a05c00">${r.finalUrl}</a>`));
    }
    if (r.hero && r.hero.issue) {
      details.push(detailRow('Hero issue', r.hero.issue));
    }
    if (r.hero && r.hero.text) {
      details.push(detailRow('Hero text', `"${r.hero.text.slice(0, 100)}${r.hero.text.length > 100 ? '…' : ''}"`, 'font-style:italic;color:#666'));
    }
    if (r.about && r.about.status === 'short') {
      details.push(detailRow('About', `${r.about.wordCount} words (min 100)${r.about.text ? ` — "${r.about.text.slice(0, 80)}…"` : ''}`));
    }

    return `
      <tr>
        <td style="padding:16px 0;border-bottom:1px solid #eee;vertical-align:top">
          <div style="font-weight:600;color:#1a1916;margin-bottom:8px">${r.linkText || r.originalHref}</div>
          <div style="margin-bottom:10px">${tags.join('')}</div>
          <table cellpadding="0" cellspacing="0" style="width:100%">${details.join('')}</table>
        </td>
      </tr>`;
  }).join('');

  const largePageRows = largePages.map(r => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #eee;vertical-align:top">
        <div style="font-weight:600;color:#1a1916;margin-bottom:4px">
          <a href="${r.originalHref}" style="color:#2a6496;text-decoration:none">${r.linkText || r.originalHref}</a>
        </div>
        <div style="font-size:12px;color:#a05c00">${formatBytes(r.payloadBytes)} &nbsp;·&nbsp; avg ${formatBytes(r.avgPayloadBytes)}</div>
      </td>
    </tr>`).join('');

  const noIssuesBlock = issuePages.length === 0
      ? `<p style="color:#2d7a4f;font-weight:500;font-size:15px">✓ No issues found — all pages are healthy.</p>`
      : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Site Checker — ${site}</title></head>
<body style="margin:0;padding:0;background:#f7f6f3;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.07)">
        <tr>
          <td style="background:#1a1916;padding:24px 32px">
            <span style="font-size:20px;color:#fff;font-weight:600">Site<span style="color:#7ab3d4;font-style:italic">Checker</span></span>
            <span style="font-size:12px;color:#aaa;margin-left:12px">${site}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 0">
            <div style="font-size:12px;color:#888;margin-bottom:6px">${date}</div>
            <h1 style="margin:0;font-size:22px;font-weight:600;color:#1a1916">
              ${issueCount === 0 ? 'All clear' : `${issueCount} issue${issueCount !== 1 ? 's' : ''} found`}
            </h1>
            <div style="font-size:13px;color:#666;margin-top:6px">Audit report for <strong>${site}</strong></div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px">
            <table cellpadding="0" cellspacing="0"><tr>
              ${pill(s.navOk, '#2d7a4f', 'Nav OK')}
              ${pill(s.navDead, '#b93030', 'Dead Links')}
              ${pill(s.navWrongPath, '#a05c00', 'Wrong Destination')}
              ${pill(s.heroIssues, '#a05c00', 'Hero Issues')}
              ${pill(s.aboutIssues, '#a05c00', 'About Issues')}
            </tr></table>
          </td>
        </tr>
        <tr><td style="padding:0 32px"><hr style="border:none;border-top:1px solid #eee;margin:0"></td></tr>
        <tr>
          <td style="padding:24px 32px">
            ${noIssuesBlock}
            ${issuePages.length > 0 ? `
            <h2 style="margin:0 0 16px;font-size:14px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:0.06em">Pages with issues</h2>
            <table width="100%" cellpadding="0" cellspacing="0">${issueRows}</table>` : ''}
            ${largePages.length > 0 ? `
            <h2 style="margin:${issuePages.length > 0 ? '32px' : '0'} 0 16px;font-size:14px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:0.06em">Large pages</h2>
            <p style="font-size:12px;color:#888;margin:0 0 12px">Pages exceeding 2× the average payload of ${formatBytes(s.avgPayloadBytes)}.</p>
            <table width="100%" cellpadding="0" cellspacing="0">${largePageRows}</table>` : ''}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;background:#f7f6f3;border-top:1px solid #eee">
            <div style="font-size:11px;color:#aaa">Generated by SiteChecker · ${data.summary.total} pages checked · ${date}</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Download report endpoint ─────────────────────────────────────────────────
app.get('/api/download-report', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url query param required');

  const data = loadResult(url);
  if (!data) return res.status(404).send('No stored result for this site — run an audit first');

  const site = new URL(data.url).hostname;
  const date = new Date(data.crawledAt).toISOString().slice(0, 10);
  const filename = `sitechecker-${site}-${date}.html`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buildEmailHtml(data));
});

const PORT = 3333;
app.listen(PORT, () => {
  console.log(`\n✅ Site Checker running at http://localhost:${PORT}\n`);
});
