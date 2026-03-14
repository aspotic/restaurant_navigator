#!/usr/bin/env node
/**
 * Saskatchewan Restaurant Health Inspection Scraper (Incremental)
 *
 * On first run, scrapes everything from scratch.
 * On subsequent runs, loads existing data and only fetches:
 *   - New facilities not yet in the JSON
 *   - New inspections for known facilities
 * Existing data is never lost.
 *
 * Usage:
 *   node scraper.js              # Incremental update (all facilities)
 *   node scraper.js --limit 500  # Incremental update (first 500 from API)
 *   node scraper.js --full       # Force full re-scrape (backs up existing data first)
 */

import * as cheerio from "cheerio";
import { writeFileSync, mkdirSync, existsSync, readFileSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_URL = "https://healthinspections.saskatchewan.ca";
const MAP_DATA_URL = `${BASE_URL}/Restaurants/MapData`;
const FACILITY_URL = (id) => `${BASE_URL}/Facility/Details/${id}`;
const INSPECTION_URL = (id) => `${BASE_URL}/Inspection/Details/${id}`;

const OUTPUT_DIR = resolve(__dirname, "..", "data");
const OUTPUT_FILE = resolve(OUTPUT_DIR, "restaurants.json");

const DELAY_MS = 250;
const MAX_RETRIES = 3;

// ─── Helpers ──────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { limit: 0, full: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      config.limit = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === "--full") {
      config.full = true;
    }
  }
  return config;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function progressBar(current, total, label = "") {
  const pct = Math.round((current / total) * 100);
  const filled = Math.round(pct / 2);
  const bar = "█".repeat(filled) + "░".repeat(50 - filled);
  process.stdout.write(
    `\r  ${bar} ${pct}% (${current}/${total}) ${label.padEnd(40).slice(0, 40)}`
  );
}

// ─── Session management ───────────────────────────────────

let sessionCookie = "";

async function acceptDisclaimer() {
  console.log("🔐 Accepting site disclaimer...");
  const resp = await fetch(`${BASE_URL}/?returnUrl=%2F`, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SaskRestaurantScraper/1.0",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "AcceptDisclaimerButton=Accept",
    redirect: "manual",
  });

  const cookies = resp.headers.getSetCookie
    ? resp.headers.getSetCookie()
    : [resp.headers.get("set-cookie")].filter(Boolean);

  sessionCookie = cookies.map((c) => c.split(";")[0]).join("; ");

  if (!sessionCookie) {
    throw new Error("Failed to obtain session cookie");
  }
  console.log("  ✓ Session established");
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SaskRestaurantScraper/1.0",
          Accept: "text/html,application/xhtml+xml,application/json",
          Cookie: sessionCookie,
        },
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }
      const text = await resp.text();
      if (text.includes("AcceptDisclaimerButton")) {
        console.warn("\n  ⚠ Session expired, re-accepting disclaimer...");
        await acceptDisclaimer();
        return fetchWithRetry(url, retries - attempt);
      }
      return text;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(
        `\n  ⚠ Attempt ${attempt}/${retries} failed for ${url}: ${err.message}`
      );
      await sleep(1000 * attempt);
    }
  }
}

// ─── Existing data management ─────────────────────────────

function loadExistingData() {
  if (!existsSync(OUTPUT_FILE)) return [];
  try {
    const raw = readFileSync(OUTPUT_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

function buildExistingIndex(existingData) {
  // facilityId → { facility record, Set of known inspection IDs }
  const index = new Map();
  for (const r of existingData) {
    const knownInspectionIds = new Set(r.inspections.map((i) => i.id));
    index.set(r.id, { record: r, knownInspectionIds });
  }
  return index;
}

function backupExistingData() {
  if (!existsSync(OUTPUT_FILE)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupFile = resolve(OUTPUT_DIR, `restaurants_backup_${ts}.json`);
  copyFileSync(OUTPUT_FILE, backupFile);
  console.log(`  📦 Backed up existing data to ${backupFile}`);
}

// ─── Step 1: Fetch all facility IDs from MapData endpoint ──

async function fetchFacilityIds() {
  console.log("📡 Fetching facility list from MapData endpoint...");
  const url = `${MAP_DATA_URL}?FacilityCountLimit=0&ProgramAreaName=Restaurants`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 SaskRestaurantScraper/1.0",
      Accept: "application/json",
      Cookie: sessionCookie,
    },
  });
  const data = await resp.json();
  const markers = data.Markers || [];

  const facilities = [];
  for (const m of markers) {
    const ids = (m.Ids || "").split(",").filter(Boolean);
    for (const id of ids) {
      facilities.push({
        id: id.trim(),
        name: ids.length > 1 ? "" : m.Title || "",
        lat: m.Lat || null,
        lng: m.Lng || null,
      });
    }
  }

  console.log(
    `  Found ${markers.length} markers → ${facilities.length} unique facilities`
  );
  return facilities;
}

// ─── Step 2: Scrape a facility detail page ─────────────────

async function scrapeFacility(facilityId) {
  const html = await fetchWithRetry(FACILITY_URL(facilityId));
  const $ = cheerio.load(html);

  const name = $("h1.article-title").first().text().trim()
    || $("h2").first().text().trim();

  let address = "";
  let community = "";

  $("span.display-label").each((_, el) => {
    const label = $(el).text().trim().toLowerCase();
    const field = $(el).closest("td").next("td.detail-field").find("span.display-field").text().trim();

    if (label.includes("site address")) {
      address = field.replace(/\s+/g, " ");
    }
    if (label === "community") {
      community = field;
    }
  });

  const inspectionIds = [];
  const onclickRegex = /Inspection\/Details\/([a-f0-9-]{36})/gi;

  $("[onclick]").each((_, el) => {
    const onclick = $(el).attr("onclick") || "";
    const matches = [...onclick.matchAll(onclickRegex)];
    for (const m of matches) {
      if (!inspectionIds.includes(m[1])) {
        inspectionIds.push(m[1]);
      }
    }
  });

  $("a[href*='Inspection/Details']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/Inspection\/Details\/([a-f0-9-]{36})/i);
    if (match && !inspectionIds.includes(match[1])) {
      inspectionIds.push(match[1]);
    }
  });

  return { name, address, community, inspectionIds };
}

// ─── Step 3: Scrape an inspection detail page ──────────────

async function scrapeInspection(inspectionId) {
  const html = await fetchWithRetry(INSPECTION_URL(inspectionId));
  const $ = cheerio.load(html);

  let date = "";
  let type = "";

  $("span.display-label").each((_, el) => {
    const label = $(el).text().trim().toLowerCase();
    const field = $(el).closest("td").next("td.detail-field").find("span.display-field").text().trim();

    if (label === "date") {
      date = field;
    }
    if (label === "inspection type") {
      type = field;
    }
  });

  const infractions = [];

  $("td.canned-comments").each((_, td) => {
    const $td = $(td);
    const category = $td.clone().children().remove().end().text().trim();

    const descriptions = [];
    $td.find("li").each((_, li) => {
      const desc = $(li).text().trim().replace(/\s+/g, " ");
      if (desc) descriptions.push(desc);
    });

    const status = $td.siblings("td.inspection-answer").text().trim() ||
      $td.next("td").text().trim();

    if (category) {
      infractions.push({
        category,
        description: descriptions.join(" | "),
        status: status || "Unknown",
      });
    }
  });

  return { date, type, infractions };
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const config = parseArgs();
  console.log("🍽️  Saskatchewan Restaurant Health Inspection Scraper");
  console.log("━".repeat(55));

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Load existing data
  const existingData = config.full ? [] : loadExistingData();
  const existingIndex = buildExistingIndex(existingData);

  if (existingData.length > 0 && !config.full) {
    console.log(`📂 Loaded existing data: ${existingData.length} facilities`);
    const totalKnownInspections = existingData.reduce((s, r) => s + r.inspections.length, 0);
    console.log(`   ${totalKnownInspections} inspections already on file`);
  } else if (config.full && existingData.length > 0) {
    backupExistingData();
    console.log("🔄 Full re-scrape mode: starting from scratch");
  }

  // Accept disclaimer to get session
  await acceptDisclaimer();

  // Step 1: Get all facility IDs
  let facilities = await fetchFacilityIds();

  if (config.limit > 0) {
    facilities = facilities.slice(0, config.limit);
    console.log(`  📋 Limited to ${facilities.length} facilities`);
  }

  // Classify facilities
  const newFacilityIds = [];
  const knownFacilityIds = [];
  for (const f of facilities) {
    if (existingIndex.has(f.id)) {
      knownFacilityIds.push(f);
    } else {
      newFacilityIds.push(f);
    }
  }

  if (existingData.length > 0) {
    console.log(`\n  📊 ${knownFacilityIds.length} known facilities (checking for new inspections)`);
    console.log(`  📊 ${newFacilityIds.length} new facilities (full scrape)`);
  }

  // Start with existing data as our result set
  // We'll update known facilities in-place and append new ones
  const resultsMap = new Map();
  for (const r of existingData) {
    resultsMap.set(r.id, r);
  }

  let errorCount = 0;
  let newInspectionCount = 0;
  let newFacilityCount = 0;
  let skippedCount = 0;

  // ─── Phase 1: Check known facilities for new inspections ──
  if (knownFacilityIds.length > 0) {
    console.log(`\n🔍 Checking known facilities for new inspections...`);
    const total = knownFacilityIds.length;

    for (let i = 0; i < total; i++) {
      const facility = knownFacilityIds[i];
      const existing = existingIndex.get(facility.id);
      const displayName = existing.record.name || facility.id.slice(0, 8);

      progressBar(i + 1, total, displayName);

      try {
        await sleep(DELAY_MS);
        const facilityData = await scrapeFacility(facility.id);

        // Always refresh facility metadata (fixes missing names)
        const record = resultsMap.get(facility.id);
        if (facilityData.name) record.name = facilityData.name;
        if (facilityData.address) record.address = facilityData.address;
        if (facilityData.community) record.community = facilityData.community;

        // Find inspection IDs we haven't scraped yet
        const newInspIds = facilityData.inspectionIds.filter(
          (id) => !existing.knownInspectionIds.has(id)
        );

        if (newInspIds.length === 0) {
          skippedCount++;
          continue;
        }

        // Scrape only the new inspections
        const newInspections = [];
        for (const inspId of newInspIds) {
          await sleep(DELAY_MS);
          try {
            const inspData = await scrapeInspection(inspId);
            newInspections.push({
              id: inspId,
              date: inspData.date,
              type: inspData.type,
              infractions: inspData.infractions,
            });
          } catch (err) {
            console.warn(`\n  ⚠ Error scraping inspection ${inspId}: ${err.message}`);
            errorCount++;
          }
        }

        if (newInspections.length > 0) {
          record.inspections.push(...newInspections);
          record.totalInfractions = record.inspections.reduce(
            (sum, insp) => sum + insp.infractions.length, 0
          );
          newInspectionCount += newInspections.length;
          console.log(`\n  ✨ ${displayName}: +${newInspections.length} new inspection(s)`);
        }
      } catch (err) {
        console.warn(`\n  ⚠ Error checking facility ${facility.id}: ${err.message}`);
        errorCount++;
      }
    }
  }

  // ─── Phase 2: Full scrape for new facilities ──────────────
  if (newFacilityIds.length > 0) {
    console.log(`\n\n🏢 Scraping ${newFacilityIds.length} new facilities...`);
    const total = newFacilityIds.length;

    for (let i = 0; i < total; i++) {
      const facility = newFacilityIds[i];
      progressBar(i + 1, total, facility.name.slice(0, 30) || facility.id.slice(0, 8));

      try {
        await sleep(DELAY_MS);
        const facilityData = await scrapeFacility(facility.id);

        const inspections = [];
        for (const inspId of facilityData.inspectionIds) {
          await sleep(DELAY_MS);
          try {
            const inspData = await scrapeInspection(inspId);
            inspections.push({
              id: inspId,
              date: inspData.date,
              type: inspData.type,
              infractions: inspData.infractions,
            });
          } catch (err) {
            console.warn(`\n  ⚠ Error scraping inspection ${inspId}: ${err.message}`);
            errorCount++;
          }
        }

        const result = {
          id: facility.id,
          name: facilityData.name || facility.name,
          community: facilityData.community,
          address: facilityData.address,
          lat: facility.lat,
          lng: facility.lng,
          inspections,
          totalInfractions: inspections.reduce(
            (sum, insp) => sum + insp.infractions.length, 0
          ),
        };

        resultsMap.set(facility.id, result);
        newFacilityCount++;
        newInspectionCount += inspections.length;
      } catch (err) {
        console.warn(`\n  ⚠ Error scraping facility ${facility.id}: ${err.message}`);
        errorCount++;
      }
    }
  }

  // ─── Save ─────────────────────────────────────────────────
  const results = [...resultsMap.values()];

  console.log(`\n\n💾 Saving ${results.length} facilities to ${OUTPUT_FILE}`);
  writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf-8");

  // Summary
  const totalInspections = results.reduce((s, r) => s + r.inspections.length, 0);
  const totalInfractions = results.reduce((s, r) => s + r.totalInfractions, 0);
  const communities = new Set(results.map((r) => r.community).filter(Boolean));

  console.log("\n📊 Summary:");
  console.log(`  Total facilities:      ${results.length}`);
  console.log(`  Total inspections:     ${totalInspections}`);
  console.log(`  Total infractions:     ${totalInfractions}`);
  console.log(`  Communities:           ${communities.size}`);
  console.log(`  ─────────────────────────────`);
  console.log(`  New facilities added:  ${newFacilityCount}`);
  console.log(`  New inspections found: ${newInspectionCount}`);
  console.log(`  Facilities unchanged:  ${skippedCount}`);
  if (errorCount > 0) console.log(`  Errors encountered:    ${errorCount}`);
  console.log(`\n✅ Done! Data saved to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err.message);
  process.exit(1);
});
