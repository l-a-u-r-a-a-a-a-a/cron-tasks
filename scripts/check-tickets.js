const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const KNOWN_IDS_FILE = path.join(__dirname, '..', 'known_ids.txt');
const WATCHLIST_FILE = path.join(__dirname, '..', 'watchlist.txt');
const WATCHLIST_STATE_FILE = path.join(__dirname, '..', 'watchlist_state.json');

// Build the newest-first search URL for any subdomain base. Each subdomain can
// list events the others don't, so every subscribed subdomain is scraped.
function searchUrl(base) {
  return (
    `${base}/events?event=&location=${encodeURIComponent(LOCATION)}` +
    `&range=${RANGE}&genre=&daterange=&${HIDE_PARAM}=True&sort=newest`
  );
}

function pageUrl(base, page) {
  const u = searchUrl(base);
  return page === 1 ? u : `${u}&page=${page}`;
}

// Per-subdomain state file. The owner's base keeps known_ids.txt for
// continuity; others use a short hash so no subdomain name appears in the repo.
function knownIdsFile(base) {
  if (base === BASE_URL) return KNOWN_IDS_FILE;
  const h = crypto.createHash('sha1').update(base).digest('hex').slice(0, 10);
  return path.join(__dirname, '..', `known_${h}.txt`);
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function parseEvents(html, base) {
  const events = [];
  const regex =
    /<a class="btn[^"]*stretched-link btn-primary"[^>]*data-name="([^"]+)"[^>]*href="(\/events\/(\d+)-[^"]+)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    events.push({
      id: match[3],
      title: decodeHtmlEntities(match[1]),
      path: match[2], // /events/NNNNNN-slug — host-agnostic, so links can be built per subdomain
      url: base + match[2],
    });
  }
  return events;
}

function hasNextPage(html, page) {
  return html.includes(`page=${page + 1}`);
}

async function fetchPage(base, page) {
  const res = await fetch(pageUrl(base, page));
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching page ${page}`);
  const html = await res.text();
  return { events: parseEvents(html, base), hasNext: hasNextPage(html, page) };
}

// First run for a subdomain: collect every event across all pages
async function fetchAllEvents(base) {
  const all = [];
  let page = 1;
  while (true) {
    console.log(`  Fetching page ${page}...`);
    const { events, hasNext } = await fetchPage(base, page);
    all.push(...events);
    if (!hasNext || events.length === 0) break;
    page++;
  }
  return all;
}

// Subsequent runs: keep fetching pages while every event on the page is new.
// Stops as soon as we hit a known event — no point looking further back.
async function fetchNewEvents(base, knownIds) {
  const newEvents = [];
  let page = 1;
  while (true) {
    console.log(`  Fetching page ${page}...`);
    const { events, hasNext } = await fetchPage(base, page);
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

function loadKnownIds(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return new Set(content.split('\n').filter(Boolean));
  } catch {
    return null; // null signals first run for this subdomain
  }
}

function saveKnownIds(file, ids) {
  fs.writeFileSync(file, [...ids].join('\n'));
}

// Low-level WhatsApp send to one phone via CallMeBot.
async function sendWhatsAppTo(phone, apikey, message) {
  if (!phone || !apikey) return;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apikey)}`;
  const res = await fetch(url);
  console.log(`WhatsApp response (${phone}):`, res.status);
}

// Owner-only WhatsApp (used for the live notice and watchlist alerts).
async function sendWhatsApp(message) {
  const phone = process.env.WHATSAPP_PHONE;
  const apikey = process.env.WHATSAPP_APIKEY;
  if (!phone || !apikey) {
    console.log('WhatsApp skipped (no credentials)');
    return;
  }
  await sendWhatsAppTo(phone, apikey, message);
}

// All WhatsApp recipients with their own subdomain for links: the owner
// (WHATSAPP_PHONE/APIKEY on BASE_URL) plus friends from WHATSAPP_RECIPIENTS_JSON,
// e.g. [{"phone":"+44...","apikey":"123","base":"https://nhs.ticketsforgood.co.uk"}]
function whatsappRecipients() {
  const list = [];
  if (process.env.WHATSAPP_PHONE && process.env.WHATSAPP_APIKEY) {
    list.push({ phone: process.env.WHATSAPP_PHONE, apikey: process.env.WHATSAPP_APIKEY, base: BASE_URL });
  }
  try {
    for (const r of JSON.parse(process.env.WHATSAPP_RECIPIENTS_JSON || '[]')) {
      if (r && r.phone && r.apikey) {
        list.push({ phone: r.phone, apikey: r.apikey, base: String(r.base || BASE_URL).replace(/\/+$/, '') });
      }
    }
  } catch (err) {
    console.error('WHATSAPP_RECIPIENTS_JSON is not valid JSON — ignoring:', err.message);
  }
  return list;
}

// Low-level send: everyone goes in BCC so recipients can't see each other.
async function sendMail(recipients, subject, body) {
  const emailFrom = process.env.EMAIL_FROM;
  const emailPassword = process.env.EMAIL_PASSWORD;
  const list = [...new Set((recipients || []).map((r) => (r || '').trim()).filter(Boolean))];
  if (!emailFrom || !emailPassword || list.length === 0) {
    console.log('Email skipped (no credentials or no recipients)');
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: emailFrom, pass: emailPassword },
  });
  await transporter.sendMail({ from: emailFrom, to: emailFrom, bcc: list, subject, text: body });
  console.log(`Email sent to ${list.length} recipient(s)`);
}

// Convenience for the monitor owner's own messages (live notice, watchlist).
async function sendEmail(subject, body) {
  await sendMail([process.env.EMAIL_TO], subject, body);
}

// Map base URL -> list of emails. The owner (EMAIL_TO) is on the monitored
// site; friends on other TFG subdomains come from the RECIPIENTS_JSON secret,
// e.g. {"https://nhs.ticketsforgood.co.uk":["a@x.com"],"https://charities.ticketsforgood.co.uk":["b@y.com"]}
// Each group is emailed links on its own subdomain. Base URLs live in a secret
// so no subdomains or emails appear in this public repo.
function recipientGroups() {
  const groups = {};
  const add = (base, email) => {
    if (!base || !email) return;
    const b = String(base).replace(/\/+$/, '');
    (groups[b] = groups[b] || new Set()).add(String(email).trim());
  };
  if (process.env.EMAIL_TO) add(BASE_URL, process.env.EMAIL_TO);
  try {
    const parsed = JSON.parse(process.env.RECIPIENTS_JSON || '{}');
    for (const [base, emails] of Object.entries(parsed)) {
      for (const e of [].concat(emails)) add(base, e);
    }
  } catch (err) {
    console.error('RECIPIENTS_JSON is not valid JSON — ignoring friends:', err.message);
  }
  return groups;
}

async function main() {
  await checkWatchlist();

  const emailGroups = recipientGroups(); // base -> Set(emails)
  const waList = whatsappRecipients(); // [{phone, apikey, base}]

  // Scrape every subdomain that has at least one subscriber (plus the owner's).
  // Each subdomain can list events the others don't, so each is checked
  // independently against its own known-events file.
  const bases = new Set([BASE_URL, ...Object.keys(emailGroups), ...waList.map((r) => r.base)]);

  for (const base of bases) {
    const label = base === BASE_URL ? 'owner site' : base.replace(/^https?:\/\//, '').split('.')[0];
    console.log(`\n=== Checking ${label} ===`);
    const file = knownIdsFile(base);
    const knownIds = loadKnownIds(file);

    // First time we've seen this subdomain: seed silently, don't alert.
    if (knownIds === null) {
      console.log('  First check — seeding known events, no alerts');
      const allEvents = await fetchAllEvents(base);
      if (allEvents.length === 0) {
        console.error('  WARNING: 0 events parsed — skipping (will retry next cycle)');
        continue;
      }
      console.log(`  Seeding ${allEvents.length} events`);
      saveKnownIds(file, new Set(allEvents.map((e) => e.id)));
      // The owner's very first run gets a one-off "live" confirmation.
      if (base === BASE_URL) {
        const msg = `Event monitor is live! Watching for new ${LOCATION} events. Currently tracking ${allEvents.length} events.`;
        await sendWhatsApp(msg);
        await sendEmail('Event monitor is live!', msg);
      }
      continue;
    }

    const newEvents = await fetchNewEvents(base, knownIds);
    console.log(`  ${newEvents.length} new event(s)`);
    if (newEvents.length === 0) continue;

    for (const e of newEvents) knownIds.add(e.id);
    saveKnownIds(file, knownIds);

    // Email: the recipients subscribed to THIS subdomain, links on this site.
    const emails = [...(emailGroups[base] || [])];
    if (emails.length > 0) {
      const lines = newEvents.map((e) => `• ${e.title}\n  ${base}${e.path}`).join('\n\n');
      await sendMail(
        emails,
        `${newEvents.length} new ${LOCATION} event(s)`,
        `${newEvents.length} new event(s) found:\n\n${lines}`
      );
    }

    // WhatsApp: recipients on THIS subdomain, links on this site. Cap at 5.
    const waSlice = newEvents.slice(0, 5);
    const waSuffix = newEvents.length > 5 ? `\n\n...and ${newEvents.length - 5} more` : '';
    const waLines = waSlice.map((e) => `• ${e.title}\n  ${base}${e.path}`).join('\n\n');
    for (const r of waList.filter((x) => x.base === base)) {
      await sendWhatsAppTo(r.phone, r.apikey, `${newEvents.length} new ${LOCATION} event(s)!\n\n${waLines}${waSuffix}`);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
