"use strict";

/**
 * Web Summit People Scraper & Connector
 *
 * For each person in the People list this script:
 *   1. Scrapes: name, designation, company, location, LinkedIn handle
 *   2. Sends a personalised connection request to every connectable profile
 *
 * Rate-limit handling (429):
 *   When the app signals rate-limiting, sending is paused for 30 min.
 *   The pause timestamp is stored in output/rate_limit.json so it survives
 *   restarts.  Scraping continues uninterrupted during the cooldown.
 *
 * Re-run safely:
 *   • Profiles already fully processed are skipped.
 *   • Profiles with a pending task continue where they left off.
 *   • New profiles that appeared between runs are picked up automatically.
 *
 * Output (written live after every profile):
 *   output/profiles.json   – full structured state
 *   output/profiles.csv    – flat export for Excel / Sheets
 *   output/rate_limit.json – rate-limit cooldown state (auto-cleared)
 */

const { remote } = require("webdriverio");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

// Ensure Android SDK env vars are set — Appium requires at least one of these.
// We resolve from the standard macOS install path if not already exported.
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  const sdkPath = path.join(
    process.env.HOME || "",
    "Library",
    "Android",
    "sdk",
  );
  if (fs.existsSync(sdkPath)) {
    process.env.ANDROID_HOME = sdkPath;
    process.env.ANDROID_SDK_ROOT = sdkPath;
  }
}

const OUT_DIR = cfg.outputDir;
const DATA_FILE = path.join(OUT_DIR, "profiles.json");
const CSV_FILE = path.join(OUT_DIR, "profiles.csv");
const RATE_FILE = path.join(OUT_DIR, "rate_limit.json");

// Backoff sequence (ms) after each consecutive 429 hit.
// Cycles: 30 min → 10 min → 5 min → 30 min → …
// Index resets to 0 on a successful send (rate limit cleared).
const RATE_SEQUENCE_MS = [30 * 60 * 1000, 10 * 60 * 1000, 5 * 60 * 1000];

// Columns written to CSV (order matters for Excel)
const CSV_COLS = [
  "name",
  "designation",
  "company",
  "location",
  "linkedin",
  "status",
  "profileId",
  "listAlias",
  "scrapedAt",
  "updatedAt",
  "rawText",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Persistence ───────────────────────────────────────────────────────────────

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadProfiles() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return new Map((raw.profiles || []).map((p) => [p.profileId, p]));
    }
  } catch {}
  return new Map();
}

function saveProfiles(map) {
  ensureDir(OUT_DIR);
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(
      {
        lastRun: new Date().toISOString(),
        total: map.size,
        profiles: Array.from(map.values()),
      },
      null,
      2,
    ),
  );
}

function escapeCSV(val) {
  if (val === null || val === undefined) return "";
  const s = String(val).replace(/\r?\n/g, " ↵ ");
  if (s.includes(",") || s.includes('"'))
    return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCSV(map) {
  const lines = [CSV_COLS.join(",")];
  for (const p of map.values()) {
    lines.push(CSV_COLS.map((col) => escapeCSV(p[col])).join(","));
  }
  fs.writeFileSync(CSV_FILE, lines.join("\n") + "\n", "utf8");
}

function upsertProfile(map, profileId, patch) {
  const existing = map.get(profileId) || {
    profileId,
    name: null,
    designation: null,
    company: null,
    location: null,
    linkedin: null,
    status: "unknown",
    rawText: null,
    tasks: { scraped: false, connectionSent: false },
    scrapedAt: null,
    updatedAt: null,
  };
  const updated = {
    ...existing,
    ...patch,
    tasks: { ...existing.tasks, ...(patch.tasks || {}) },
  };
  updated.updatedAt = new Date().toISOString();
  map.set(profileId, updated);
  return updated;
}

// ── Rate-limit helpers ────────────────────────────────────────────────────────

function loadRateLimit() {
  try {
    if (fs.existsSync(RATE_FILE))
      return JSON.parse(fs.readFileSync(RATE_FILE, "utf8"));
  } catch {}
  return {};
}

function isRateLimited() {
  const d = loadRateLimit();
  return !!(d.blockedUntil && new Date(d.blockedUntil) > new Date());
}

function rateLimitResumesAt() {
  const d = loadRateLimit();
  return d.blockedUntil ? new Date(d.blockedUntil) : null;
}

function setRateLimited() {
  ensureDir(OUT_DIR);
  const d = loadRateLimit();
  // Advance through [30, 10, 5] minute cycle, then repeat
  const prevIdx = typeof d.seqIdx === "number" ? d.seqIdx : -1;
  const nextIdx = (prevIdx + 1) % RATE_SEQUENCE_MS.length;
  const waitMs = RATE_SEQUENCE_MS[nextIdx];
  const blockedUntil = new Date(Date.now() + waitMs).toISOString();
  fs.writeFileSync(
    RATE_FILE,
    JSON.stringify(
      {
        blockedUntil,
        triggeredAt: new Date().toISOString(),
        seqIdx: nextIdx,
        waitMinutes: Math.round(waitMs / 60000),
      },
      null,
      2,
    ),
  );
  return {
    resumeAt: new Date(blockedUntil),
    waitMinutes: Math.round(waitMs / 60000),
  };
}

function clearRateLimit() {
  try {
    if (fs.existsSync(RATE_FILE)) fs.unlinkSync(RATE_FILE);
  } catch {}
}

// ── Country filter support ─────────────────────────────────────────────────────

const PROGRESS_FILE = path.join(OUT_DIR, "progress.json");

// Countries list provided by user (exact app filter list)
const COUNTRIES = [
  "Afghanistan",
  "Åland Islands",
  "Albania",
  "Algeria",
  "American Samoa",
  "Andorra",
  "Angola",
  "Anguilla",
  "Antarctica",
  "Antigua and Barbuda",
  "Argentina",
  "Armenia",
  "Aruba",
  "Australia",
  "Austria",
  "Azerbaijan",
  "Bahamas",
  "Bahrain",
  "Bangladesh",
  "Barbados",
  "Belarus",
  "Belgium",
  "Belize",
  "Benin",
  "Bermuda",
  "Bhutan",
  "Bolivia",
  "Bonaire, Sint Eustatius and Saba",
  "Bosnia and Herzegovina",
  "Botswana",
  "Bouvet Island",
  "Brazil",
  "British Indian Ocean Territory",
  "Brunei Darussalam",
  "Bulgaria",
  "Burkina Faso",
  "Burundi",
  "Cabo Verde",
  "Cambodia",
  "Cameroon",
  "Canada",
  "Cayman Islands",
  "Central African Republic",
  "Chad",
  "Chile",
  "China",
  "Christmas Island",
  "Cocos (Keeling) Islands",
  "Colombia",
  "Comoros",
  "Congo",
  "Congo (Democratic Republic of the)",
  "Cook Islands",
  "Costa Rica",
  "Côte d'Ivoire",
  "Croatia",
  "Cuba",
  "Curaçao",
  "Cyprus",
  "Czechia",
  "Denmark",
  "Djibouti",
  "Dominica",
  "Dominican Republic",
  "Ecuador",
  "Egypt",
  "El Salvador",
  "Equatorial Guinea",
  "Eritrea",
  "Estonia",
  "Eswatini",
  "Ethiopia",
  "Falkland Islands (Malvinas)",
  "Faroe Islands",
  "Fiji",
  "Finland",
  "France",
  "French Guiana",
  "French Polynesia",
  "French Southern Territories",
  "Gabon",
  "Gambia",
  "Georgia",
  "Germany",
  "Ghana",
  "Gibraltar",
  "Greece",
  "Greenland",
  "Grenada",
  "Guadeloupe",
  "Guam",
  "Guatemala",
  "Guernsey",
  "Guinea",
  "Guinea-Bissau",
  "Guyana",
  "Haiti",
  "Heard Island and McDonald Islands",
  "Holy See",
  "Honduras",
  "Hong Kong",
  "Hungary",
  "Iceland",
  "India",
  "Indonesia",
  "Iran (Islamic Republic of)",
  "Iraq",
  "Ireland",
  "Isle of Man",
  "Israel",
  "Italy",
  "Jamaica",
  "Japan",
  "Jersey",
  "Jordan",
  "Kazakhstan",
  "Kenya",
  "Kiribati",
  "Korea (Democratic People's Republic of)",
  "Korea (Republic of)",
  "Kosovo, Republic of",
  "Kuwait",
  "Kyrgyzstan",
  "Lao People's Democratic Republic",
  "Latvia",
  "Lebanon",
  "Lesotho",
  "Liberia",
  "Libya",
  "Liechtenstein",
  "Lithuania",
  "Luxembourg",
  "Macao",
  "Madagascar",
  "Malawi",
  "Malaysia",
  "Maldives",
  "Mali",
  "Malta",
  "Marshall Islands",
  "Martinique",
  "Mauritania",
  "Mauritius",
  "Mayotte",
  "Mexico",
  "Micronesia (Federated States of)",
  "Moldova (Republic of)",
  "Monaco",
  "Mongolia",
  "Montenegro",
  "Montserrat",
  "Morocco",
  "Mozambique",
  "Myanmar",
  "Namibia",
  "Nauru",
  "Nepal",
  "Netherlands",
  "New Caledonia",
  "New Zealand",
  "Nicaragua",
  "Niger",
  "Nigeria",
  "Niue",
  "Norfolk Island",
  "Northern Mariana Islands",
  "North Macedonia",
  "Norway",
  "Oman",
  "Pakistan",
  "Palau",
  "Palestine, State of",
  "Panama",
  "Papua New Guinea",
  "Paraguay",
  "Peru",
  "Philippines",
  "Pitcairn",
  "Poland",
  "Portugal",
  "Puerto Rico",
  "Qatar",
  "Réunion",
  "Romania",
  "Russian Federation",
  "Rwanda",
  "Saint Barthélemy",
  "Saint Helena, Ascension and Tristan da Cunha",
  "Saint Kitts and Nevis",
  "Saint Lucia",
  "Saint Martin (French part)",
  "Saint Pierre and Miquelon",
  "Saint Vincent and the Grenadines",
  "Samoa",
  "San Marino",
  "Sao Tome and Principe",
  "Saudi Arabia",
  "Senegal",
  "Serbia",
  "Seychelles",
  "Sierra Leone",
  "Singapore",
  "Sint Maarten (Dutch part)",
  "Slovakia",
  "Slovenia",
  "Solomon Islands",
  "Somalia",
  "South Africa",
  "South Georgia and the South Sandwich Islands",
  "South Sudan",
  "Spain",
  "Sri Lanka",
  "Sudan",
  "Suriname",
  "Svalbard and Jan Mayen",
  "Sweden",
  "Switzerland",
  "Syrian Arab Republic",
  "Taiwan",
  "Tajikistan",
  "Tanzania, United Republic of",
  "Thailand",
  "Timor-Leste",
  "Togo",
  "Tokelau",
  "Tonga",
  "Trinidad and Tobago",
  "Tunisia",
  "Türkiye",
  "Turkmenistan",
  "Turks and Caicos Islands",
  "Tuvalu",
  "Uganda",
  "Ukraine",
  "United Arab Emirates",
  "United Kingdom",
  "United States",
  "United States Minor Outlying Islands",
  "Uruguay",
  "Uzbekistan",
  "Vanuatu",
  "Venezuela (Bolivarian Republic of)",
  "Viet Nam",
  "Virgin Islands (British)",
  "Virgin Islands (U.S.)",
  "Wallis and Futuna",
  "Western Sahara",
  "Yemen",
  "Zambia",
  "Zimbabwe",
];

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    }
  } catch {}
  return { currentCountry: null, countryIndex: 0 };
}

function saveProgress(data) {
  ensureDir(OUT_DIR);
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

async function applyCountryFilter(driver, countryName) {
  // Ensure the country filter dialog is open (caller should open it when needed).
  // 1. Find and focus the search box
  const searchBox = await waitForEl(
    driver,
    "//android.widget.EditText",
    cfg.timing.dialogTimeout,
  );
  if (!searchBox) {
    console.warn(
      `      country dialog search box not found — skipping ${countryName}`,
    );
    return false;
  }

  // 2. Clear search box and type country name
  await searchBox.clearValue();
  await sleep(300);
  await searchBox.setValue(countryName);
  await sleep(800);

  // 3. Check if the country appeared in the search results
  const xml = await driver.getPageSource();
  if (!xml.includes(countryName)) {
    console.warn(`      country not found in filter — skipping ${countryName}`);
    return false;
  }

  // 4. Tap the first result row to apply the filter
  await tapAt(driver, 360, 450);
  await sleep(1500); // Wait for list to reload with filter applied
  return true;
}

async function listHasAttendees(driver) {
  const xml = await driver.getPageSource();
  if (xml.includes("No results found")) return false;
  const avatarCount = (xml.match(/content-desc="Avatar"/g) || []).length;
  return avatarCount >= 1;
}

async function clearCountryFilter(driver) {
  // Tap X button on active filter chip
  await tapAt(driver, 189, 488);
  await sleep(800);
}

async function reopenCountryDialog(driver) {
  // After clearing the filter, reopen the country filter dialog for the next country
  await tapAt(driver, 110, 488); // Tap Country chip to open dialog
  await sleep(1000);
}

function playDeviceSoundFor(seconds) {
  const alertFile = path.join(__dirname, "alert.wav");
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    spawnSync("afplay", [alertFile], { timeout: 10000 });
  }
}

// ── XPaths used only for smart-wait polling (not for attribute fetching) ──────

// Profile page: confirms we navigated away from the list
const XPATH_PROFILE_ROOT = "//android.widget.ScrollView";
// List cards: used by waitForList to detect the list is back after Back press
const XPATH_LIST_CARDS =
  '//android.view.View[@scrollable="true"]' +
  '[.//android.view.View[@content-desc="Avatar"]]' +
  '/*/android.view.View[@clickable="true"]' +
  '[.//android.view.View[@content-desc="Avatar"]]';
// Connect dialog input
const XPATH_MSG_INPUT = "//android.widget.EditText";

// ── Content-desc markers for profile state detection ─────────────────────────
const BADGE_SET = new Set([
  "ALPHA",
  "BETA",
  "PARTNER",
  "ATTENDEE",
  "SPEAKER",
  "EXHIBITOR",
  "VIP",
  "ORGANIZER",
  "PRESS",
  "INVESTOR",
]);
const UI_CHROME_SET = new Set([
  "Connect",
  "Connection requested",
  "Get in touch",
  "Connect to reveal contact details",
  "Send connection request",
  "Topics",
  "Back",
  "Share",
]);

// ── Smart-wait helpers (polling, minimal round-trips) ─────────────────────────

async function waitForEl(driver, xpath, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || cfg.timing.profileTimeout);
  while (Date.now() < deadline) {
    try {
      const el = await driver.$(xpath);
      if (await el.isDisplayed()) return el;
    } catch {}
    await sleep(120);
  }
  return null;
}

async function waitForList(driver) {
  // Use page source instead of XPath so filtered lists work too.
  // With a filter active the people list's LazyColumn is NOT marked
  // scrollable="true", so XPATH_LIST_CARDS returns nothing.
  // Counting Avatar nodes is reliable: list = 2+, profile/dialog = 1.
  const deadline = Date.now() + cfg.timing.listTimeout;
  while (Date.now() < deadline) {
    try {
      const xml = await driver.getPageSource();
      const count = (xml.match(/content-desc="Avatar"/g) || []).length;
      if (count >= 2) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

// ── Fast page-source parser ───────────────────────────────────────────────────
// Replaces per-element getAttribute() calls (each ~50–80ms) with a single
// getPageSource() call (~150ms) parsed locally in-memory.

/**
 * Parse all XML elements from Appium page source into a flat array.
 * Appium UIAutomator2 format uses class-name tag names with attributes.
 */
function parseSource(xml) {
  const elements = [];
  const re = /<([\w.]+)(\s[^>]*?)?\s*\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[1];
    if (tag === "?xml" || tag === "hierarchy") continue;
    const attrStr = m[2] || "";
    const el = { _tag: tag };
    const ar = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(attrStr)) !== null) el[a[1]] = a[2];
    elements.push(el);
  }
  return elements;
}

function parseBoundsRect(b) {
  const m = b && b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = [+m[1], +m[2], +m[3], +m[4]];
  return {
    x1,
    y1,
    x2,
    y2,
    cx: Math.round((x1 + x2) / 2),
    cy: Math.round((y1 + y2) / 2),
  };
}

function boundsContains(outer, inner) {
  return (
    inner.x1 >= outer.x1 &&
    inner.y1 >= outer.y1 &&
    inner.x2 <= outer.x2 &&
    inner.y2 <= outer.y2
  );
}

async function tapAt(driver, x, y) {
  await driver
    .action("pointer")
    .move({ x, y, duration: 0 })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
}

// ── List scanning (1 round-trip) ──────────────────────────────────────────────

/**
 * Returns all visible profile cards from a single getPageSource() call.
 * Each card: { name, designationLine, companyTag, center: {x,y} }
 */
async function scanList(driver) {
  const xml = await driver.getPageSource();
  return extractListCards(parseSource(xml));
}

function extractListCards(elements) {
  const avatars = elements.filter((e) => e["content-desc"] === "Avatar");
  if (!avatars.length) return [];

  const cards = [];
  const usedBounds = new Set();

  for (const avatar of avatars) {
    const ar = parseBoundsRect(avatar.bounds);
    if (!ar) continue;

    // Skip event-banner avatars.  Person-card avatars are ~184 px wide;
    // banner avatars (today's events strip) are ~80 px wide.
    // Using width rather than height so partially-visible person cards
    // (cropped at top/bottom) are still processed correctly.
    if (ar.x2 - ar.x1 < 120) continue;

    // Find smallest clickable View that fully contains this avatar
    let bestCard = null,
      bestArea = Infinity;
    for (const e of elements) {
      if (e.clickable !== "true" || usedBounds.has(e.bounds)) continue;
      const r = parseBoundsRect(e.bounds);
      if (!r || !boundsContains(r, ar)) continue;
      const area = (r.x2 - r.x1) * (r.y2 - r.y1);
      if (area < bestArea) {
        bestArea = area;
        bestCard = { e, r };
      }
    }
    if (!bestCard || usedBounds.has(bestCard.e.bounds)) continue;
    usedBounds.add(bestCard.e.bounds);

    // If the best clickable container spans too much of the screen vertically
    // (e.g. the whole list area in a filtered view), it's a layout container,
    // not an individual card.  In that case use Avatar-centred bounds so that:
    //   • the tap goes to the right card (Avatar Y, not container midpoint)
    //   • TextViews are scoped to this card's area (not the whole screen)
    const containerHeight = bestCard.r.y2 - bestCard.r.y1;
    const avatarHeight = ar.y2 - ar.y1;
    const effectiveBounds =
      containerHeight > avatarHeight * 3
        ? {
            x1: 0,
            y1: ar.y1 - 30,
            x2: 720,
            y2: ar.y2 + 80,
            cx: bestCard.r.cx,
            cy: ar.cy,
          }
        : bestCard.r;

    // TextViews inside effective card bounds, sorted top-to-bottom
    const tvs = elements
      .filter((e) => {
        if (!e._tag.includes("TextView")) return false;
        const t = (e.text || "").trim();
        if (!t || t.toLowerCase() === "null" || e.bounds === "[0,0][0,0]")
          return false;
        const r = parseBoundsRect(e.bounds);
        return r && boundsContains(effectiveBounds, r);
      })
      .sort(
        (a, b) =>
          (parseBoundsRect(a.bounds)?.y1 || 0) -
          (parseBoundsRect(b.bounds)?.y1 || 0),
      );

    if (!tvs.length) continue;

    // Secondary banner guard: event cards lead with a date/time string
    // e.g. "Today • 12:00 pm – 12:55 pm".  Skip them regardless of avatar size.
    const firstText = tvs[0]?.text.trim() || "";
    if (
      /^(Today|Tomorrow|\w+day)\s*[•·]|\d{1,2}:\d{2}\s*(am|pm)/i.test(firstText)
    )
      continue;

    cards.push({
      name: firstText || null,
      designationLine: tvs[1]?.text.trim() || null,
      companyTag: tvs[2]?.text.trim() || null,
      center: { x: effectiveBounds.cx, y: effectiveBounds.cy },
    });
  }

  return cards.sort((a, b) => a.center.y - b.center.y);
}

// ── Profile scraping + state detection (1 round-trip) ────────────────────────

/**
 * Reads profile page data and connection state in a single getPageSource() call.
 * Returns all scraped fields plus actionState and connectCenter for tapping.
 */
async function readProfile(driver, knownName) {
  const xml = await driver.getPageSource();
  return extractProfileData(parseSource(xml), knownName);
}

function extractProfileData(elements, knownName) {
  // Action state from content-desc markers (set membership = O(1))
  const descs = new Set(elements.map((e) => e["content-desc"] || ""));
  let actionState = "none";
  if (descs.has("Connect")) actionState = "connect";
  else if (descs.has("Connection requested")) actionState = "requested";
  else if (descs.has("Attendee get in touch click")) actionState = "accepted";

  // Connect button center — needed so caller can tap it without another round-trip.
  // Compose Views are often clickable=false in the accessibility tree even when
  // tappable, so fall back to the marker's own bounds center when no clickable
  // parent is found.
  let connectCenter = null;
  if (actionState === "connect") {
    const marker = elements.find((e) => e["content-desc"] === "Connect");
    if (marker) {
      const mr = parseBoundsRect(marker.bounds);
      if (mr) {
        let best = null,
          bestArea = Infinity;
        for (const e of elements) {
          if (e.clickable !== "true") continue;
          const r = parseBoundsRect(e.bounds);
          if (r && boundsContains(r, mr)) {
            const area = (r.x2 - r.x1) * (r.y2 - r.y1);
            if (area < bestArea) {
              bestArea = area;
              best = { x: r.cx, y: r.cy };
            }
          }
        }
        connectCenter = best ?? { x: mr.cx, y: mr.cy };
      }
    }
  }

  // All visible TextViews, sorted top-to-bottom
  const tvs = elements
    .filter((e) => {
      if (!e._tag.includes("TextView")) return false;
      const t = (e.text || "").trim();
      return t && t.toLowerCase() !== "null" && e.bounds !== "[0,0][0,0]";
    })
    .sort(
      (a, b) =>
        (parseBoundsRect(a.bounds)?.y1 || 0) -
        (parseBoundsRect(b.bounds)?.y1 || 0),
    );

  // Location: TextView at same Y as the "Open location" icon
  let location = null;
  const locIcon = elements.find((e) => e["content-desc"] === "Open location");
  if (locIcon) {
    const lr = parseBoundsRect(locIcon.bounds);
    if (lr) {
      for (const tv of tvs) {
        const r = parseBoundsRect(tv.bounds);
        if (
          r &&
          Math.abs(r.y1 - lr.y1) < 50 &&
          !BADGE_SET.has(tv.text.trim())
        ) {
          location = tv.text.trim();
          break;
        }
      }
    }
  }

  // LinkedIn: TextView at same Y as the "LinkedIn" icon
  let linkedin = null;
  const liIcon = elements.find((e) => e["content-desc"] === "LinkedIn");
  if (liIcon) {
    const lr = parseBoundsRect(liIcon.bounds);
    if (lr) {
      for (const tv of tvs) {
        const r = parseBoundsRect(tv.bounds);
        if (r && Math.abs(r.y1 - lr.y1) < 50 && tv.text.trim() !== location) {
          linkedin = tv.text.trim();
          break;
        }
      }
    }
  }

  // Name and designation line: first two non-chrome TextViews before "Topics"
  const topicsIdx = tvs.findIndex((tv) => tv.text.trim() === "Topics");
  const pool = tvs
    .slice(0, topicsIdx >= 0 ? topicsIdx : undefined)
    .filter((tv) => {
      const t = tv.text.trim();
      // Exclude known chrome/badge labels, location, linkedin
      if (BADGE_SET.has(t) || UI_CHROME_SET.has(t)) return false;
      if (t === location || t === linkedin) return false;
      // Exclude all-caps community/track labels like "WOMEN IN TECH", "STARTUP SUMMIT" etc.
      if (t === t.toUpperCase() && /[A-Z]{2}/.test(t)) return false;
      return true;
    });

  // pool[0] is always the person's name on the profile page (after badge/all-caps
  // filtering). Do NOT anchor to knownName — the list card may show a tagline
  // (e.g. "Growth at Pantheon") instead of the real name, so using knownName as
  // an anchor can skip the actual name and pick up the wrong text.
  const name = pool[0]?.text.trim() || knownName;
  const designationLine = pool[1]?.text.trim() || null;
  const { designation, company } = parseDesignationLine(designationLine);
  const rawText = tvs.map((tv) => tv.text.trim()).join(" | ");

  return {
    name,
    designation,
    company,
    location,
    linkedin,
    rawText,
    actionState,
    connectCenter,
  };
}

// ── Scroll ────────────────────────────────────────────────────────────────────

async function scrollListDown(driver) {
  const { width, height } = await driver.getWindowSize();

  // Note the last visible card before scrolling — used to detect end-of-list.
  // mobile: scrollGesture is unreliable on Compose apps, so we use a raw
  // pointer swipe (mirrors what `adb input swipe` does) and compare card names.
  const cardsBefore = await scanList(driver);
  const lastBefore = cardsBefore[cardsBefore.length - 1]?.name ?? null;

  await driver
    .action("pointer")
    .move({
      duration: 0,
      x: Math.round(width / 2),
      y: Math.round(height * 0.75),
    })
    .down({ button: 0 })
    .move({
      duration: 700,
      x: Math.round(width / 2),
      y: Math.round(height * 0.2),
    })
    .up({ button: 0 })
    .perform();
  await sleep(cfg.timing.afterScroll);

  const cardsAfter = await scanList(driver);
  const lastAfter = cardsAfter[cardsAfter.length - 1]?.name ?? null;

  // If the last visible card didn't change, the list didn't advance.
  return lastAfter !== lastBefore || cardsAfter.length > cardsBefore.length;
}

// Scroll up to list top — used when scrollGesture reports no movement, to
// trigger pull-to-refresh / pagination before concluding the list is finished.
async function pullToTop(driver) {
  const { width, height } = await driver.getWindowSize();
  // Swipe DOWN (finger moves down = content moves up = scroll to top)
  await driver
    .action("pointer")
    .move({
      duration: 0,
      x: Math.round(width / 2),
      y: Math.round(height * 0.2),
    })
    .down({ button: 0 })
    .move({
      duration: 900,
      x: Math.round(width / 2),
      y: Math.round(height * 0.8),
    })
    .up({ button: 0 })
    .perform();
  await sleep(cfg.timing.afterScroll * 3); // wait longer for potential new-batch load
}

// ── Stable profile ID (generated from list card, no profile-page open needed) ─

/**
 * Produces a deterministic ID from the three fields visible on the list card.
 * Normalised to lowercase + collapsed whitespace so minor rendering differences
 * don't create duplicates.  Unique enough for this dataset; no hashing needed.
 */
function makeProfileId(name, designationLine, companyTag) {
  return [name, designationLine, companyTag]
    .map((s) => (s || "").trim().toLowerCase().replace(/\s+/g, " "))
    .join(" | ");
}

// ── Designation parser ────────────────────────────────────────────────────────

function parseDesignationLine(line) {
  if (!line) return { designation: null, company: null };
  const idx = line.lastIndexOf(" at ");
  if (idx < 0) return { designation: line.trim(), company: null };
  return {
    designation: line.substring(0, idx).trim() || null,
    company: line.substring(idx + 4).trim() || null,
  };
}

// ── Connection flow ───────────────────────────────────────────────────────────

/**
 * Type the personalised message and tap Send.
 * Called after the caller has already tapped the Connect button.
 *
 * Throws 'RATE_LIMITED' if the Send button is still present after clicking,
 * which indicates the app rejected the request due to rate limiting.
 */
async function sendConnectionMessage(driver, firstName) {
  const msgInput = await waitForEl(
    driver,
    XPATH_MSG_INPUT,
    cfg.timing.dialogTimeout,
  );
  if (!msgInput) throw new Error("Message input not found in connect dialog");

  const rawMsg = cfg.connectionMessage.replace("{{first_name}}", firstName);
  // Strip newlines: on Android, \n in setValue can trigger the soft keyboard's
  // Done/Send action, which submits the form and closes the dialog before we
  // can tap the actual Send button.
  const flat = rawMsg.replace(/\n+/g, " ").trim();
  const message = flat.length > 200 ? flat.substring(0, 197) + "…" : flat;

  // Do NOT click the EditText before typing — clicking opens the soft keyboard,
  // which pushes the Send button behind it.  UiAutomator2's clearValue/setValue
  // work directly on the element without needing keyboard focus.
  await msgInput.clearValue();
  await sleep(cfg.timing.settle);
  await msgInput.setValue(message);
  await sleep(cfg.timing.afterType);

  // Find Send button via Appium XPath
  let sendEl = null;
  for (const xpath of [
    '//android.view.View[@content-desc="Send connection request"]',
    '//*[@text="Send connection request"]',
  ]) {
    try {
      const el = await driver.$(xpath);
      if (await el.isExisting()) {
        sendEl = el;
        break;
      }
    } catch {}
  }
  if (!sendEl) throw new Error("Send button not found");

  await sendEl.click();

  // After clicking Send, poll for up to 5 s.
  //
  // SUCCESS  → Send button disappears (dialog dismissed by the app)
  // RATE_LIMITED → detected in two ways:
  //   1. Fast path: any text containing "429" appears in the page source
  //      (the app shows a Compose Snackbar, NOT a system Toast, so we scan
  //       all visible TextViews rather than looking for android.widget.Toast)
  //   2. Fallback: dialog is still open after 5 s — in this app a non-closing
  //      dialog always means the server rejected the request
  const SEND_POLL_MS = 150;
  const SEND_TIMEOUT = 5000;
  const sendDeadline = Date.now() + SEND_TIMEOUT;

  while (Date.now() < sendDeadline) {
    await sleep(SEND_POLL_MS);

    // Grab page source once per poll — single round-trip covers both checks
    let xml;
    try {
      xml = await driver.getPageSource();
    } catch {
      continue;
    }

    // ── 429 fast path: any visible text containing "429" ─────────────────
    const texts = [...xml.matchAll(/text="([^"]+)"/g)].map((m) => m[1]);
    const errorText = texts.find((t) => t.includes("HTTP 429"));
    if (errorText) {
      console.warn(`    rate-limit signal in UI: "${errorText}"`);
      throw new Error("RATE_LIMITED");
    }

    // ── Success: Send button gone = dialog dismissed ──────────────────────
    if (!xml.includes('content-desc="Send connection request"')) return;
  }

  // Timed out: dialog still open, no 429 text seen → still a rejection
  console.warn(
    "    Send dialog still open after 5 s — treating as rate-limited",
  );
  throw new Error("RATE_LIMITED");
}

// ── Sound alert (plays on the Mac when the script stops) ─────────────────────

function playDeviceSound() {
  const alertFile = path.join(__dirname, "alert.wav");
  spawnSync("afplay", [alertFile], { timeout: 10000 });
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Main scrape loop extraction (called per-country when filtering enabled) ────

async function scrapeCurrentList(driver, profiles, connectionsSentRunRef) {
  let staleScrolls = 0;
  let processedRun = 0;
  let hasScrolledSuccessfully = false;
  const seenNames = new Set();
  const loggedSkips = new Set();
  while (true) {
    const cards = await scanList(driver);

    // Detect names we have never seen before this scroll pass.
    const newNamesThisScan = cards.filter(
      (c) => c.name && !seenNames.has(c.name),
    );
    cards.forEach((c) => {
      if (c.name) seenNames.add(c.name);
    });

    let foundPending = false;

    for (const card of cards) {
      if (!card || !card.name) continue;

      const { name, designationLine, companyTag } = card;

      // Stable ID derived purely from list card — no profile page open required.
      const listId = makeProfileId(name, designationLine, companyTag);

      // Primary lookup by listId; fall back to old name-based key for migration.
      let existing = profiles.get(listId);
      if (!existing) {
        for (const p of profiles.values()) {
          if (p.listAlias === name || p.profileId === name) {
            // Migrate old entry to new key in-place
            profiles.delete(p.profileId);
            p.profileId = listId;
            profiles.set(listId, p);
            existing = p;
            break;
          }
        }
      }

      const isScraped = existing?.tasks?.scraped ?? false;
      const isSent = existing?.tasks?.connectionSent ?? false;
      // Re-read rate limit from disk each iteration so cooldown expiry is picked up mid-run.
      const rateLimited = isRateLimited();
      const canSend = !isSent && !rateLimited;

      const needsScrape = !isScraped;
      const needsConnect = canSend;

      // Fast skip — connection already sent (requested or accepted).
      // Decision made entirely from list card data; profile is never opened.
      if (!needsScrape && !needsConnect) {
        if (!loggedSkips.has(listId)) {
          loggedSkips.add(listId);
          const sendStatus = isSent
            ? "✓"
            : rateLimited
              ? "⏸ rate-limited"
              : "✗";
          console.log(
            `    [skip] ${name}  (scraped=${isScraped ? "✓" : "✗"}, sent=${sendStatus})`,
          );
        }
        continue;
      }

      // Found a pending profile — process it
      foundPending = true;
      staleScrolls = 0;

      // Clear any stale skip-log entry so re-attempts are logged
      loggedSkips.delete(listId);

      const tasks = [];
      if (needsScrape) tasks.push("scrape");
      if (needsConnect) tasks.push("connect");
      console.log(`[→] ${name}  (${tasks.join(" + ")})`);

      try {
        // ── Open profile ──────────────────────────────────────────────────
        await tapAt(driver, card.center.x, card.center.y);
        const profileRoot = await waitForEl(
          driver,
          XPATH_PROFILE_ROOT,
          cfg.timing.profileTimeout,
        );
        if (!profileRoot) throw new Error("Profile page did not load");

        // ── Single round-trip: scrape data + detect action state ──────────
        const profileData = await readProfile(driver, name);
        const { actionState, connectCenter } = profileData;

        // Sync task state from what the app already shows
        const taskPatch = {};
        if (actionState === "requested" || actionState === "accepted") {
          taskPatch.connectionSent = true;
        }

        // ── Scrape ────────────────────────────────────────────────────────
        let scrapePatch = {};
        if (needsScrape) {
          const data = profileData;
          const company = data.company || companyTag || null;

          scrapePatch = {
            name: data.name || name,
            designation: data.designation,
            company,
            location: data.location,
            linkedin: data.linkedin,
            rawText: data.rawText,
            listAlias: name,
            scrapedAt: new Date().toISOString(),
            tasks: { scraped: true },
          };

          console.log(
            `    scraped → ` +
              `name="${data.name}" | desig="${data.designation}" | ` +
              `co="${company}" | loc="${data.location}"`,
          );
        }

        // ── Send connection ───────────────────────────────────────────────
        let connectPatch = {};
        if (needsConnect && actionState === "connect") {
          await sleep(500); // let Connect button fully render before tapping
          const firstName = (scrapePatch.name || name).split(" ")[0];
          try {
            const connectEl = await driver.$(
              '//android.view.View[@content-desc="Connect"]',
            );
            if (await connectEl.isExisting()) {
              await connectEl.click();
            } else if (connectCenter) {
              await tapAt(driver, connectCenter.x, connectCenter.y);
            } else {
              throw new Error("Connect button not found");
            }
          } catch {
            if (!connectCenter) throw new Error("Connect button not found");
            await tapAt(driver, connectCenter.x, connectCenter.y);
          }

          await sendConnectionMessage(driver, firstName);

          connectionsSentRun++;
          connectPatch = {
            status: "requested",
            tasks: { connectionSent: true },
          };
          console.log(
            `    ✓ connection sent  (total this run: ${connectionsSentRun})`,
          );
        } else if (needsConnect && actionState !== "connect") {
          // App already shows sent/accepted — mark done without re-sending
          connectPatch = { tasks: { connectionSent: true } };
          console.log(`    ⚑ connect skipped — app state: ${actionState}`);
        }

        // Merge all patches and persist
        const merged = {
          ...scrapePatch,
          ...connectPatch,
          status: actionState,
          tasks: {
            scraped:
              scrapePatch.tasks?.scraped ?? existing?.tasks?.scraped ?? false,
            connectionSent:
              connectPatch.tasks?.connectionSent ??
              taskPatch.connectionSent ??
              existing?.tasks?.connectionSent ??
              false,
          },
        };

        upsertProfile(profiles, listId, merged);
        saveProfiles(profiles);
        writeCSV(profiles);
        processedRun++;
      } catch (err) {
        if (err.message === "RATE_LIMITED") {
          const { resumeAt, waitMinutes } = setRateLimited();
          console.warn(
            `    ⚠ Rate-limited — pausing sends for ${waitMinutes} min (until ${resumeAt.toLocaleTimeString()})`,
          );
          console.warn(
            "      Scraping continues; next attempt follows backoff: 30→10→5→30 min cycle.",
          );
          // Do NOT mark connectionSent — we'll retry when the cooldown expires
        } else {
          console.error(`    ✗ Error: ${err.message}`);
        }
        // Still save partial data so we don't lose it on restart
        saveProfiles(profiles);
        writeCSV(profiles);
      }

      // ── Return to list — press back until the list cards reappear ────────
      // A single back may only dismiss a dialog (→ profile page); try up to 3×.
      for (let backTry = 0; backTry < 3; backTry++) {
        try {
          await driver.back();
        } catch {}
        await sleep(cfg.timing.settle);
        if (await waitForList(driver)) break;
      }
      await sleep(cfg.timing.settle);

      // Restart scan from the beginning of the visible list.
      break;
    }

    // ── Scroll if no pending items were visible ───────────────────────────
    if (!foundPending) {
      if (newNamesThisScan.length > 0) {
        // New profiles visible but already fully processed — list IS advancing.
        staleScrolls = 0;
        console.log(
          `  (${newNamesThisScan.length} new profiles visible but already done — scrolling…)`,
        );
      } else {
        staleScrolls++;
        if (staleScrolls > cfg.maxStaleScrolls) {
          console.log("\nNo new profiles after multiple scrolls — stopping.");
          break;
        }
        const rateLimited = isRateLimited();
        const resumeAt = rateLimited ? rateLimitResumesAt() : null;
        if (rateLimited) {
          console.log(
            `  (rate-limited — sending paused until ${resumeAt.toLocaleTimeString()} — scroll ${staleScrolls})`,
          );
        } else {
          console.log(`  (no new profiles in view — scroll ${staleScrolls})`);
        }
      }

      const moved = await scrollListDown(driver);
      if (moved) {
        hasScrolledSuccessfully = true;
      } else if (!hasScrolledSuccessfully) {
        // List has never scrolled → small or filtered list with no more data.
        // Skip pullToTop entirely: on filtered lists the downward swipe can
        // trigger pull-to-refresh or a navigation gesture that leaves the screen.
        console.log(
          "\nEnd of list reached (small/filtered list — no pagination needed).",
        );
        break;
      } else {
        // List scrolled before but won't move now → try pull-to-top to
        // trigger pagination and load the next batch.
        console.log("  (scroll returned end — pulling to top for pagination…)");
        await pullToTop(driver);
        await waitForList(driver);
        const moved2 = await scrollListDown(driver);
        if (!moved2) {
          console.log("\nEnd of list reached (confirmed after pull-to-top).");
          break;
        }
        hasScrolledSuccessfully = true;
        console.log("  (new data loaded after pull-to-top — continuing…)");
      }
    }
  }

  return processedRun;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(OUT_DIR);

  const profiles = loadProfiles();

  // ── Show startup status ───────────────────────────────────────────────────
  console.log("┌────────────────────────────────────────────────┐");
  console.log("│  Web Summit – People Scraper & Connector        │");
  console.log("└────────────────────────────────────────────────┘");
  console.log(`  Package  : ${cfg.device.appPackage}`);
  console.log(`  Device   : ${cfg.device.name}`);
  console.log(`  Output   : ${path.resolve(OUT_DIR)}`);
  console.log("");

  const alreadySent = Array.from(profiles.values()).filter(
    (p) => p.tasks?.connectionSent,
  ).length;
  console.log(`  Profiles in DB    : ${profiles.size}`);
  console.log(`  Already connected : ${alreadySent}`);

  if (isRateLimited()) {
    const resumeAt = rateLimitResumesAt();
    console.log(
      `  Rate-limit active : sending PAUSED until ${resumeAt.toLocaleTimeString()}`,
    );
    console.log("  (scraping will continue; sending resumes automatically)");
  } else {
    console.log("  Rate-limit status : clear — sending enabled");
    clearRateLimit(); // remove stale file if cooldown already expired
  }
  console.log("");

  // ── Check for CLI flags ───────────────────────────────────────────────────
  const NO_FILTER = process.argv.includes("--nofilter");
  if (NO_FILTER) {
    console.log("  Mode: --nofilter (scraping without country filter)\n");
  } else {
    console.log("  Mode: country-by-country filtering enabled\n");
  }

  // ── Graceful exit ─────────────────────────────────────────────────────────
  let driver = null;
  let connectionsSentRun = 0;
  const shutdown = async (sig) => {
    console.log(`\nStopped (${sig}).`);
    saveProfiles(profiles);
    writeCSV(profiles);
    console.log(
      `  Profiles saved: ${profiles.size}  |  Connections sent this run: ${connectionsSentRun}`,
    );
    if (driver)
      try {
        await driver.deleteSession();
      } catch {}
    playDeviceSound();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  driver = await remote({
    hostname: cfg.appium.hostname,
    port: cfg.appium.port,
    logLevel: "warn",
    capabilities: {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": cfg.device.name,
      "appium:appPackage": cfg.device.appPackage,
      "appium:appActivity": cfg.device.appActivity,
      "appium:noReset": cfg.device.noReset,
      "appium:newCommandTimeout": 120,
    },
  });

  // Wait for the app's People list to be ready before starting
  await sleep(cfg.timing.afterAppLaunch);
  await waitForList(driver);
  console.log("Connected. Starting…\n");

  try {
    // ── Country loop (if filtering enabled) ───────────────────────────────────
    if (NO_FILTER) {
      // Standard unfiltered scrape
      const processedThisRun = await scrapeCurrentList(driver, profiles, {
        current: connectionsSentRun,
      });
      connectionsSentRun = { current: connectionsSentRun }.current;
    } else {
      // Country-by-country filtering
      const progress = loadProgress();
      let startIndex = progress.countryIndex ?? 0;

      for (let i = startIndex; i < COUNTRIES.length; i++) {
        const country = COUNTRIES[i];
        saveProgress({ currentCountry: country, countryIndex: i });
        console.log(`\n🌍 Country ${i + 1}/${COUNTRIES.length}: ${country}`);

        try {
          // On subsequent countries, reopen the dialog after clearing the filter
          if (i > startIndex) {
            await reopenCountryDialog(driver);
          } else {
            // First country in this run: open the dialog automatically
            await tapAt(driver, 110, 488); // open Country chip
            await sleep(1000);
          }

          const found = await applyCountryFilter(driver, country);
          if (!found) {
            console.log(`  (not in app filter — skip)\n`);
            // Clear filter for next country
            await clearCountryFilter(driver);
            await sleep(500);
            continue;
          }

          const hasAttendees = await listHasAttendees(driver);
          if (!hasAttendees) {
            console.log(`  (no attendees — skip)\n`);
            // Clear the filter for next country
            await clearCountryFilter(driver);
            await sleep(500);
            continue;
          }

          // Scrape this country's attendees
          console.log(`  Scraping attendees for ${country}…`);
          const connectionsSentRef = { current: connectionsSentRun };
          const processedThisCountry = await scrapeCurrentList(
            driver,
            profiles,
            connectionsSentRef,
          );
          connectionsSentRun = connectionsSentRef.current;

          // Play alert sound
          playDeviceSound();
          console.log(
            `  ✓ ${country} complete — ${processedThisCountry} profiles processed\n`,
          );

          // Clear filter for next country
          await clearCountryFilter(driver);
          await sleep(500);
        } catch (err) {
          console.error(`  ✗ Error processing ${country}: ${err.message}`);
          saveProfiles(profiles);
          writeCSV(profiles);
          throw err;
        }
      }

      // All countries done
      saveProgress({ currentCountry: null, countryIndex: 0 });
      console.log("\n🎉 All countries processed!");
      console.log("Playing 9-second alert...");
      playDeviceSoundFor(9);
    }

    // ── Final save ────────────────────────────────────────────────────────────
    saveProfiles(profiles);
    writeCSV(profiles);

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║  Run complete                                    ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`  Profiles total          : ${profiles.size}`);
    console.log(`  Connections sent (run)  : ${connectionsSentRun}`);
    if (isRateLimited()) {
      const resumeAt = rateLimitResumesAt();
      console.log(
        `  Rate-limit active       : sending was paused — resumes at ${resumeAt.toLocaleTimeString()}`,
      );
    }
    console.log(`  JSON  : ${path.resolve(DATA_FILE)}`);
    console.log(`  CSV   : ${path.resolve(CSV_FILE)}`);
    console.log("\n  Re-run to pick up new profiles / retry pending tasks.\n");
  } finally {
    if (driver) await driver.deleteSession();
    playDeviceSound();
  }
}

main().catch(async (err) => {
  console.error("\n✗ Fatal:", err.message);
  playDeviceSound();
  process.exit(1);
});
