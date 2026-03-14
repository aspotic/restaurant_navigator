#!/usr/bin/env node
/**
 * Repair script: fixes facilities with missing/empty names
 * by re-scraping only their facility detail pages.
 *
 * Usage: node repair-names.js
 */

import * as cheerio from "cheerio";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_URL = "https://healthinspections.saskatchewan.ca";
const FACILITY_URL = (id) => `${BASE_URL}/Facility/Details/${id}`;
const OUTPUT_FILE = resolve(__dirname, "..", "data", "restaurants.json");

const DELAY_MS = 200;
const MAX_RETRIES = 3;

let sessionCookie = "";

async function acceptDisclaimer() {
    const resp = await fetch(`${BASE_URL}/?returnUrl=%2F`, {
        method: "POST",
        headers: {
            "User-Agent": "Mozilla/5.0 SaskRestaurantScraper/1.0",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "AcceptDisclaimerButton=Accept",
        redirect: "manual",
    });
    const cookies = resp.headers.getSetCookie
        ? resp.headers.getSetCookie()
        : [resp.headers.get("set-cookie")].filter(Boolean);
    sessionCookie = cookies.map((c) => c.split(";")[0]).join("; ");
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const resp = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 SaskRestaurantScraper/1.0",
                    Cookie: sessionCookie,
                },
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            if (text.includes("AcceptDisclaimerButton")) {
                await acceptDisclaimer();
                return fetchWithRetry(url, retries - attempt);
            }
            return text;
        } catch (err) {
            if (attempt === retries) throw err;
            await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    console.log("🔧 Repairing missing restaurant names...\n");

    const data = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"));
    const broken = data.filter(
        (r) => !r.name || r.name.trim() === "" || r.name === "Unknown"
    );

    console.log(`  Total facilities: ${data.length}`);
    console.log(`  Missing names:    ${broken.length}\n`);

    if (broken.length === 0) {
        console.log("✅ Nothing to repair!");
        return;
    }

    await acceptDisclaimer();
    console.log("  ✓ Session established\n");

    let fixed = 0;
    let failed = 0;

    for (let i = 0; i < broken.length; i++) {
        const r = broken[i];
        const pct = Math.round(((i + 1) / broken.length) * 100);
        process.stdout.write(
            `\r  ${pct}% (${i + 1}/${broken.length}) Fixing ${r.id.slice(0, 8)}...`
        );

        try {
            await sleep(DELAY_MS);
            const html = await fetchWithRetry(FACILITY_URL(r.id));
            const $ = cheerio.load(html);
            const name = $('h1.article-title').first().text().trim()
                || $('h2').first().text().trim();

            if (name) {
                r.name = name;
                fixed++;
            }

            // Also repair address/community if missing
            $("span.display-label").each((_, el) => {
                const label = $(el).text().trim().toLowerCase();
                const field = $(el)
                    .closest("td")
                    .next("td.detail-field")
                    .find("span.display-field")
                    .text()
                    .trim();
                if (label.includes("site address") && (!r.address || !r.address.trim())) {
                    r.address = field.replace(/\s+/g, " ");
                }
                if (label === "community" && (!r.community || !r.community.trim())) {
                    r.community = field;
                }
            });
        } catch (err) {
            failed++;
        }
    }

    console.log(`\n\n  Fixed:  ${fixed}`);
    console.log(`  Failed: ${failed}`);

    writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), "utf-8");
    console.log(`\n✅ Saved to ${OUTPUT_FILE}`);
}

main().catch((err) => {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
});
