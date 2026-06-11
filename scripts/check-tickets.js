const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ---- Configuration (all via environment variables / repository secrets) ----
// MONITOR_BASE_URL (required, secret) — base URL of the site to monitor,
//   e.g. https://example.somewhere.com (no trailing slash needed)
// SEARCH_LOCATION (optional)          — search location, defaults to "London"
// SEARCH_RANGE (optional)             — search radius in miles, defaults to "50"
const RAW_BASE = process.env.MONITOR_BASE_URL;
const LOCATION = process.env.SEARCH_LOCATION || 'London';
const RANGE = process.env.SEARCH_RANGE || '50';

if (!RAW_BASE) {
  console.error('Missing MONITOR_BASE_URL — set it as a repository secret.');
  process.exit(1);
}

const BASE_URL = RAW_BASE.replace(/\/+$/, '');
// Site-specific markers are assembled at runtime so they don't appear as
// indexable literals in public code search
const HIDE_PARAM = ['hide', 'soldout'].join('');
const QTY_CLASS = ['ticket', 'quantity', 'select'].join('-');
const NAME_ATTR = ['data', 'ticket', 'name'].join('-');
const SEARCH_URL =
  `${BASE_URL}/events?event=&location=${encodeURIComponent(LOCATION)}` +
  `&range=${RANGE}&genre=&daterange=&${HIDE_PARAM}=True&sort=newest`;
const KNOWN_IDS_FILE = path.join(__dirname, '..', 'known_ids.txt');
const WATCHLIST_FILE = path.join(__dirname, '..', 'watchlist.txt');
const WATCHLIST_STATE_FILE = path.join(__dirname, '..', 'watchlist_state.json');

function pageUrl(page) {
  return page === 1 ? SEARCH_URL : `${SEARCH_URL}&page=${page}`;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function parseEvents(html) {
  const events = [];
  const regex =
    /<a class="btn[^"]*stretched-link btn-primary"[^>]*data-name="([^"]+)"[^>]*href="(\/events\/(\d+)-[^"]+)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    events.push({
      id: match[3],
      title: decodeHtmlEntities(match[1]),
      url: BASE_URL + match[2],
    });
  }
  return events;
}

function hasNextPage(html, page) {
  return html.includes(`page=${page + 1}`);
}

async function fetchPage(page) {
  const res = await fetch(pageUrl(page));
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching page ${page}`);
  const html = await res.text();
  return { events: parseEvents(html), hasNext: hasNextPage(html, page) };
}

// First run: collect every event across all pages
async function fetchAllEvents() {
  const all = [];
  let page = 1;
  while (true) {
    console.log(`  Fetching page ${page}...`);
    const { events, hasNext } = await fetchPage(page);
    all.push(...events);
    if (!hasNext || events.length === 0) break;
    page++;
  }
  return all;
}

// Subsequent runs: keep fetching pages while every event on the page is new.
// Stops as soon as we hit a known event — no point looking further back.
async function fetchNewEvents(knownIds) {
  const newEvents = [];
  let page = 1;
  while (true) {
    console.log(`  Fetching page ${page}...`);
    const { events, hasNext } = await fetchPage(page);
    if (events.length === 0) break;

    const pageNew = events.filter((e) => !knownIds.has(e.id));
    newEvents.push(...pageNew);

    // Hit the frontier of known events — stop
    if (pageNew.length < events.length) break;
    // No more pages
    if (!hasNext) break;

    page++;
  }
  return newEvents;
}

// ---- Watchlist: monitor specific (sold out) events for tickets coming back ----

function loadWatchlist() {
  try {
    return fs
      .readFileSync(WATCHLIST_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const m = line.match(/\/events\/(\d+)[^\s]*/) || line.match(/^(\d+)$/);
        if (!m) return null;
        return { id: m[1], url: `${BASE_URL}/events/${m[1]}` };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function loadWatchlistState() {
  try {
    return JSON.parse(fs.readFileSync(WATCHLIST_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveWatchlistState(state) {
  fs.writeFileSync(WATCHLIST_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// A ticket type is available when its quantity dropdown offers a value > 0
function parseAvailableTickets(html) {
  const available = [];
  const selectRegex = new RegExp(
    `<select[^>]*${QTY_CLASS}[^>]*${NAME_ATTR}="([^"]*)"[^>]*>([\\s\\S]*?)</select>`,
    'g'
  );
  let match;
  while ((match = selectRegex.exec(html)) !== null) {
    const name = decodeHtmlEntities(match[1]);
    const quantities = [...match[2].matchAll(/value="(\d+)"/g)].map((m) => Number(m[1]));
    const max = Math.max(0, ...quantities);
    if (max > 0) available.push({ name, max });
  }
  return available;
}

function parseEventTitle(html) {
  const og = html.match(/<meta property="og:title" content="([^"]*)"/);
  if (og) return decodeHtmlEntities(og[1]);
  const title = html.match(/<title>([^<]*)<\/title>/);
  return title ? decodeHtmlEntities(title[1].trim()) : 'Watched event';
}

async function checkWatchlist() {
  const watchlist = loadWatchlist();
  if (watchlist.length === 0) return;

  console.log(`Checking ${watchlist.length} watched event(s)...`);
  const state = loadWatchlistState();
  const alerts = [];

  for (const item of watchlist) {
    let html;
    try {
      const res = await fetch(item.url);
      if (!res.ok) {
        console.log(`  Watch ${item.id}: HTTP ${res.status} — skipping`);
        continue;
      }
      html = await res.text();
    } catch (err) {
      console.log(`  Watch ${item.id}: fetch failed (${err.message}) — skipping`);
      continue;
    }

    const tickets = parseAvailableTickets(html);
    const wasAvailable = state[item.id]?.available || false;
    const isAvailable = tickets.length > 0;
    // Title only goes into private alerts — never into public logs or state
    console.log(
      `  Watch ${item.id}: ${isAvailable ? `AVAILABLE — ${tickets.length} ticket type(s)` : 'sold out'}`
    );

    // Alert only on the sold-out -> available transition
    if (isAvailable && !wasAvailable) {
      alerts.push({ ...item, title: parseEventTitle(html), tickets });
    }
    state[item.id] = { available: isAvailable, checked: new Date().toISOString() };
  }

  // Drop state for events no longer on the watchlist
  const watchedIds = new Set(watchlist.map((i) => i.id));
  for (const id of Object.keys(state)) {
    if (!watchedIds.has(id)) delete state[id];
  }
  saveWatchlistState(state);

  if (alerts.length === 0) return;

  for (const a of alerts) {
    const ticketLines = a.tickets.map((t) => `  - ${t.name} (up to ${t.max})`).join('\n');
    const msg = `🎟 TICKETS BACK: ${a.title}\n${a.url}\n\nAvailable now:\n${ticketLines}\n\nGo go go!`;
    await sendWhatsApp(msg);
    await sendEmail(`Tickets back for ${a.title}!`, msg);
  }
}

function loadKnownIds() {
  try {
    const content = fs.readFileSync(KNOWN_IDS_FILE, 'utf8');
    return new Set(content.split('\n').filter(Boolean));
  } catch {
    return null; // null signals first run
  }
}

function saveKnownIds(ids) {
  fs.writeFileSync(KNOWN_IDS_FILE, [...ids].join('\n'));
}

async function sendWhatsApp(message) {
  const phone = process.env.WHATSAPP_PHONE;
  const apikey = process.env.WHATSAPP_APIKEY;
  if (!phone || !apikey) {
    console.log('WhatsApp skipped (no credentials)');
    return;
  }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apikey}`;
  const res = await fetch(url);
  console.log('WhatsApp response:', res.status);
}

async function sendEmail(subject, body) {
  const emailTo = process.env.EMAIL_TO;
  const emailFrom = process.env.EMAIL_FROM;
  const emailPassword = process.env.EMAIL_PASSWORD;
  if (!emailTo || !emailFrom || !emailPassword) {
    console.log('Email skipped (no credentials)');
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: emailFrom, pass: emailPassword },
  });
  await transporter.sendMail({ from: emailFrom, to: emailTo, subject, text: body });
  console.log('Email sent');
}

async function main() {
  await checkWatchlist();

  const knownIds = loadKnownIds();

  if (knownIds === null) {
    console.log('First run — fetching all pages to seed known_ids.txt...');
    const allEvents = await fetchAllEvents();
    if (allEvents.length === 0) {
      console.error('WARNING: 0 events parsed — HTML structure may have changed');
      process.exit(1);
    }
    console.log(`Seeding ${allEvents.length} events`);
    saveKnownIds(new Set(allEvents.map((e) => e.id)));
    const msg = `Event monitor is live! Watching for new ${LOCATION} events. Currently tracking ${allEvents.length} events.`;
    await sendWhatsApp(msg);
    await sendEmail('Event monitor is live!', msg);
    return;
  }

  console.log('Checking for new events...');
  const newEvents = await fetchNewEvents(knownIds);
  console.log(`${newEvents.length} new event(s) found`);
  if (newEvents.length === 0) return;

  for (const e of newEvents) knownIds.add(e.id);
  saveKnownIds(knownIds);

  // WhatsApp: cap at 5 to stay within URL length limits
  const waSlice = newEvents.slice(0, 5);
  const waLines = waSlice.map((e) => `• ${e.title}\n  ${e.url}`).join('\n\n');
  const waSuffix = newEvents.length > 5 ? `\n\n...and ${newEvents.length - 5} more` : '';
  await sendWhatsApp(`${newEvents.length} new ${LOCATION} event(s)!\n\n${waLines}${waSuffix}`);

  // Email: full list
  const emailLines = newEvents.map((e) => `• ${e.title}\n  ${e.url}`).join('\n\n');
  await sendEmail(
    `${newEvents.length} new ${LOCATION} event(s)`,
    `${newEvents.length} new event(s) found:\n\n${emailLines}`
  );
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
