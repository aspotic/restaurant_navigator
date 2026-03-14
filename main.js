/**
 * Saskatchewan Restaurant Inspector — Main Application
 */

// ─── State ────────────────────────────────────────────────
let allRestaurants = [];
let filteredRestaurants = [];
let displayedCount = 0;
const PAGE_SIZE = 30;
let currentView = "list"; // "list" or "map"
let map = null;
let markerLayer = null;

// ─── DOM Elements ─────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
    statsBar: $("#stats-bar"),
    statFacilities: $("#stat-facilities"),
    statInspections: $("#stat-inspections"),
    statInfractions: $("#stat-infractions"),
    statCommunities: $("#stat-communities"),
    dataTimestamp: $("#data-timestamp"),

    searchInput: $("#search-input"),
    filterCommunity: $("#filter-community"),
    filterInfractionType: $("#filter-infraction-type"),
    filterMaxInfractions: $("#filter-max-infractions"),
    infractionCountDisplay: $("#infraction-count-display"),
    filterInspectionType: $("#filter-inspection-type"),
    filterDateFrom: $("#filter-date-from"),
    filterDateTo: $("#filter-date-to"),
    filterSort: $("#filter-sort"),
    btnClearFilters: $("#btn-clear-filters"),
    filterPanel: $("#filter-panel"),
    btnToggleFilters: $("#btn-toggle-filters"),

    resultsCount: $("#results-count"),
    resultsGrid: $("#results-grid"),
    loadMoreContainer: $("#load-more-container"),
    btnLoadMore: $("#btn-load-more"),

    modalOverlay: $("#modal-overlay"),
    detailModal: $("#detail-modal"),
    modalClose: $("#modal-close"),
    modalContent: $("#modal-content"),

    mapContainer: $("#map-container"),
    mapEl: $("#map"),
    btnViewList: $("#btn-view-list"),
    btnViewMap: $("#btn-view-map"),
};

// ─── Data Loading ─────────────────────────────────────────

async function loadData() {
    dom.resultsGrid.innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <p>Loading restaurant data...</p>
    </div>`;

    try {
        const resp = await fetch(`${import.meta.env.BASE_URL}restaurants.json`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        allRestaurants = await resp.json();
        // Normalize community names: strip " (Net#)" suffixes
        for (const r of allRestaurants) {
            r.community = normalizeCommunity(r.community);
        }
        initializeApp();
    } catch (err) {
        dom.resultsGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">⚠️</div>
        <p class="empty-state__text">Failed to load data. Run the scraper first:<br>
        <code>cd scraper && node scraper.js --limit 200</code></p>
      </div>`;
        console.error("Data load error:", err);
    }
}

// ─── Initialize ───────────────────────────────────────────

function initializeApp() {
    buildFilterIndexes();
    populateFilters();
    updateStats();
    applyFilters();
    bindEvents();

    dom.dataTimestamp.textContent = `${allRestaurants.length} facilities loaded`;
}

// ─── Index Building ───────────────────────────────────────

let communitySet = new Set();
let infractionCategoryMap = new Map(); // category → count
let inspectionTypeSet = new Set();

function buildFilterIndexes() {
    communitySet.clear();
    infractionCategoryMap.clear();
    inspectionTypeSet.clear();

    for (const r of allRestaurants) {
        if (r.community) communitySet.add(r.community);
        for (const insp of r.inspections) {
            if (insp.type) inspectionTypeSet.add(insp.type);
            for (const inf of insp.infractions) {
                if (inf.category) {
                    infractionCategoryMap.set(
                        inf.category,
                        (infractionCategoryMap.get(inf.category) || 0) + 1
                    );
                }
            }
        }
    }
}

function populateFilters() {
    // Communities
    const communities = [...communitySet].sort();
    dom.filterCommunity.innerHTML =
        '<option value="">All Communities</option>' +
        communities.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");

    // Infraction types (sorted by frequency)
    const categories = [...infractionCategoryMap.entries()].sort(
        (a, b) => b[1] - a[1]
    );
    dom.filterInfractionType.innerHTML = categories
        .map(
            ([cat, count]) => `
      <div class="checkbox-item">
        <input type="checkbox" id="cat-${slugify(cat)}" value="${esc(cat)}">
        <label for="cat-${slugify(cat)}">${esc(cat)}</label>
        <span class="badge">${count}</span>
      </div>`
        )
        .join("");

    // Inspection types
    const inspTypes = [...inspectionTypeSet].sort();
    dom.filterInspectionType.innerHTML =
        '<option value="">All Types</option>' +
        inspTypes.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");

    // Max infractions for slider
    const maxInf = Math.max(...allRestaurants.map((r) => r.totalInfractions), 1);
    const sliderMax = Math.min(maxInf, 100);
    dom.filterMaxInfractions.max = sliderMax;
    dom.filterMaxInfractions.value = sliderMax;
    dom.infractionCountDisplay.textContent = sliderMax;
}

// ─── Filtering Engine ─────────────────────────────────────

function applyFilters() {
    const search = dom.searchInput.value.toLowerCase().trim();
    const community = dom.filterCommunity.value;
    const inspType = dom.filterInspectionType.value;
    const maxInf = parseInt(dom.filterMaxInfractions.value, 10);
    const dateFrom = dom.filterDateFrom.value;
    const dateTo = dom.filterDateTo.value;

    // Excluded infraction categories (checked = exclude)
    const excludedCategories = new Set();
    dom.filterInfractionType
        .querySelectorAll("input:checked")
        .forEach((cb) => excludedCategories.add(cb.value));

    filteredRestaurants = allRestaurants.filter((r) => {
        // Search filter
        if (search) {
            const haystack = `${r.name} ${r.address} ${r.community}`.toLowerCase();
            if (!haystack.includes(search)) return false;
        }

        // Community filter
        if (community && r.community !== community) return false;

        // Max infractions filter
        if (r.totalInfractions > maxInf) return false;

        // Exclude infraction category filter
        if (excludedCategories.size > 0) {
            const hasExcludedCategory = r.inspections.some((insp) =>
                insp.infractions.some((inf) => excludedCategories.has(inf.category))
            );
            if (hasExcludedCategory) return false;
        }

        // Inspection type filter
        if (inspType) {
            const hasType = r.inspections.some((insp) => insp.type === inspType);
            if (!hasType) return false;
        }

        // Date range filter
        if (dateFrom || dateTo) {
            const hasInRange = r.inspections.some((insp) => {
                const d = parseDate(insp.date);
                if (!d) return false;
                if (dateFrom && d < new Date(dateFrom)) return false;
                if (dateTo && d > new Date(dateTo + "T23:59:59")) return false;
                return true;
            });
            if (!hasInRange) return false;
        }

        return true;
    });

    // Sort
    sortRestaurants();

    // Reset display
    displayedCount = 0;
    dom.resultsGrid.innerHTML = "";
    showMore();

    // Update count
    dom.resultsCount.textContent = `${filteredRestaurants.length} restaurant${filteredRestaurants.length !== 1 ? "s" : ""} found`;

    // Update map if visible
    if (currentView === "map") {
        updateMap();
    }
}

function sortRestaurants() {
    const sortBy = dom.filterSort.value;
    filteredRestaurants.sort((a, b) => {
        switch (sortBy) {
            case "infractions-desc":
                return b.totalInfractions - a.totalInfractions;
            case "infractions-asc":
                return a.totalInfractions - b.totalInfractions;
            case "name-asc":
                return a.name.localeCompare(b.name);
            case "name-desc":
                return b.name.localeCompare(a.name);
            case "recent": {
                const aDate = getMostRecentDate(a);
                const bDate = getMostRecentDate(b);
                return bDate - aDate;
            }
            default:
                return 0;
        }
    });
}

function showMore() {
    const next = filteredRestaurants.slice(
        displayedCount,
        displayedCount + PAGE_SIZE
    );

    for (let i = 0; i < next.length; i++) {
        const card = createCard(next[i]);
        card.style.animationDelay = `${i * 30}ms`;
        dom.resultsGrid.appendChild(card);
    }

    displayedCount += next.length;

    if (displayedCount >= filteredRestaurants.length) {
        dom.loadMoreContainer.style.display = "none";
    } else {
        dom.loadMoreContainer.style.display = "block";
    }

    if (filteredRestaurants.length === 0) {
        dom.resultsGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🔍</div>
        <p class="empty-state__text">No restaurants match your filters</p>
      </div>`;
    }
}

// ─── Card Rendering ───────────────────────────────────────

function createCard(restaurant) {
    const card = document.createElement("div");
    card.className = "restaurant-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.dataset.id = restaurant.id;

    const inspCount = restaurant.inspections.length;
    const infCount = restaurant.totalInfractions;
    const lastDate = getLastInspectionDate(restaurant);

    let infClass = "card-stat--success";
    let infLabel = "Clean Record";
    if (infCount > 0) {
        infClass = infCount >= 5 ? "card-stat--danger" : "card-stat--warn";
        infLabel = `${infCount} infraction${infCount !== 1 ? "s" : ""}`;
    }

    card.innerHTML = `
    <div class="restaurant-card__name">${esc(restaurant.name || "Unknown")}</div>
    <div class="restaurant-card__community">${esc(restaurant.community || "—")}</div>
    <div class="restaurant-card__address">${esc(restaurant.address || "—")}</div>
    <div class="restaurant-card__stats">
      <span class="card-stat">${inspCount} inspection${inspCount !== 1 ? "s" : ""}</span>
      <span class="card-stat ${infClass}">${infLabel}</span>
      ${lastDate ? `<span class="card-stat">Last: ${lastDate}</span>` : ""}
    </div>`;

    card.addEventListener("click", () => openDetail(restaurant));
    card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(restaurant);
        }
    });

    return card;
}

// ─── Detail Modal ─────────────────────────────────────────

function openDetail(restaurant) {
    const r = restaurant;
    const inspections = [...r.inspections].sort((a, b) => {
        const da = parseDate(a.date) || new Date(0);
        const db = parseDate(b.date) || new Date(0);
        return db - da;
    });

    const totalInsp = inspections.length;
    const totalInf = r.totalInfractions;
    const uniqueCategories = new Set();
    inspections.forEach((insp) =>
        insp.infractions.forEach((inf) => uniqueCategories.add(inf.category))
    );

    dom.modalContent.innerHTML = `
    <div class="modal-name">${esc(r.name || "Unknown")}</div>
    <div class="modal-community">${esc(r.community || "—")}</div>
    <div class="modal-address">${esc(r.address || "—")}</div>

    <div class="modal-stats-grid">
      <div class="modal-stat">
        <div class="modal-stat__value">${totalInsp}</div>
        <div class="modal-stat__label">Inspections</div>
      </div>
      <div class="modal-stat">
        <div class="modal-stat__value" style="color: ${totalInf > 0 ? "var(--accent-warn)" : "var(--accent-success)"}">${totalInf}</div>
        <div class="modal-stat__label">Total Infractions</div>
      </div>
      <div class="modal-stat">
        <div class="modal-stat__value">${uniqueCategories.size}</div>
        <div class="modal-stat__label">Infraction Types</div>
      </div>
    </div>

    <h3 class="modal-section-title">Inspection History</h3>
    <div class="inspection-timeline">
      ${inspections.length > 0 ? inspections.map((insp) => renderInspectionItem(insp)).join("") : '<p class="no-infractions">No inspections on file</p>'}
    </div>

    <a class="source-link" href="https://healthinspections.saskatchewan.ca/Facility/Details/${esc(r.id)}" target="_blank" rel="noopener">
      View on Inspection InSite →
    </a>`;

    dom.modalOverlay.classList.add("active");
    document.body.style.overflow = "hidden";
}

function renderInspectionItem(insp) {
    const hasInfractions = insp.infractions.length > 0;
    return `
    <div class="inspection-item ${hasInfractions ? "inspection-item--has-infractions" : ""}">
      <div class="inspection-header">
        <span class="inspection-date">${esc(insp.date || "Unknown date")}</span>
        <span class="inspection-type-badge">${esc(insp.type || "Unknown")}</span>
      </div>
      ${hasInfractions
            ? `<div class="infraction-list">
              ${insp.infractions
                .map(
                    (inf) => `
                <div class="infraction-item">
                  <div class="infraction-category">${esc(inf.category)}</div>
                  ${inf.description ? `<div class="infraction-desc">${esc(inf.description)}</div>` : ""}
                  <div class="infraction-status">${esc(inf.status)}</div>
                </div>`
                )
                .join("")}
             </div>`
            : '<p class="no-infractions">✓ No infractions found</p>'
        }
    </div>`;
}

function closeDetail() {
    dom.modalOverlay.classList.remove("active");
    document.body.style.overflow = "";
}

// ─── Stats ────────────────────────────────────────────────

function updateStats() {
    const totalInspections = allRestaurants.reduce(
        (s, r) => s + r.inspections.length,
        0
    );
    const totalInfractions = allRestaurants.reduce(
        (s, r) => s + r.totalInfractions,
        0
    );

    animateNumber(dom.statFacilities, allRestaurants.length);
    animateNumber(dom.statInspections, totalInspections);
    animateNumber(dom.statInfractions, totalInfractions);
    animateNumber(dom.statCommunities, communitySet.size);
}

function animateNumber(el, target) {
    const duration = 600;
    const start = performance.now();
    const from = 0;

    function update(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(from + (target - from) * eased);
        el.textContent = current.toLocaleString();
        if (progress < 1) requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

// ─── Event Binding ────────────────────────────────────────

function bindEvents() {
    // Debounced search
    let searchTimeout;
    dom.searchInput.addEventListener("input", () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(applyFilters, 200);
    });

    // Instant filters
    dom.filterCommunity.addEventListener("change", applyFilters);
    dom.filterInspectionType.addEventListener("change", applyFilters);
    dom.filterSort.addEventListener("change", applyFilters);
    dom.filterDateFrom.addEventListener("change", applyFilters);
    dom.filterDateTo.addEventListener("change", applyFilters);

    // Infraction frequency slider
    dom.filterMaxInfractions.addEventListener("input", () => {
        dom.infractionCountDisplay.textContent = dom.filterMaxInfractions.value;
    });
    dom.filterMaxInfractions.addEventListener("change", applyFilters);

    // Infraction category checkboxes (delegated)
    dom.filterInfractionType.addEventListener("change", applyFilters);

    // Clear filters
    dom.btnClearFilters.addEventListener("click", clearFilters);

    // Toggle filter panel (mobile)
    dom.btnToggleFilters.addEventListener("click", () => {
        dom.filterPanel.classList.toggle("hidden");
    });

    dom.btnLoadMore.addEventListener("click", showMore);

    // View toggle
    dom.btnViewList.addEventListener("click", () => switchView("list"));
    dom.btnViewMap.addEventListener("click", () => switchView("map"));

    // Modal
    dom.modalClose.addEventListener("click", closeDetail);
    dom.modalOverlay.addEventListener("click", (e) => {
        if (e.target === dom.modalOverlay) closeDetail();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeDetail();
    });
}

function clearFilters() {
    dom.searchInput.value = "";
    dom.filterCommunity.value = "";
    dom.filterInspectionType.value = "";
    const sliderMax = parseInt(dom.filterMaxInfractions.max, 10);
    dom.filterMaxInfractions.value = sliderMax;
    dom.infractionCountDisplay.textContent = String(sliderMax);
    dom.filterDateFrom.value = "";
    dom.filterDateTo.value = "";
    dom.filterSort.value = "infractions-asc";
    dom.filterInfractionType
        .querySelectorAll("input:checked")
        .forEach((cb) => (cb.checked = false));
    applyFilters();
}

// ─── Utilities ────────────────────────────────────────────

function esc(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function slugify(str) {
    return str
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
}

function parseDate(dateStr) {
    if (!dateStr) return null;
    // Handle format: "06-Nov-2025"
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) return parsed;
    // Try DD-Mon-YYYY
    const match = dateStr.match(/(\d{2})-(\w{3})-(\d{4})/);
    if (match) {
        return new Date(`${match[2]} ${match[1]}, ${match[3]}`);
    }
    return null;
}

function getLastInspectionDate(restaurant) {
    if (!restaurant.inspections.length) return null;
    const dates = restaurant.inspections
        .map((i) => i.date)
        .filter(Boolean);
    return dates[0] || null;
}

function getMostRecentDate(restaurant) {
    if (!restaurant.inspections.length) return new Date(0);
    const dates = restaurant.inspections
        .map((i) => parseDate(i.date))
        .filter(Boolean);
    if (dates.length === 0) return new Date(0);
    return new Date(Math.max(...dates));
}

function normalizeCommunity(community) {
    if (!community) return community;
    return community.replace(/\s*\(Net\d+\)\s*$/i, "").trim();
}

// ─── Map ──────────────────────────────────────────────────

function initMap() {
    if (map) return;
    map = L.map("map", {
        zoomControl: true,
        attributionControl: true,
    }).setView([52.9, -106.5], 6); // Center of Saskatchewan

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
}

function updateMap() {
    if (!map) initMap();
    markerLayer.clearLayers();

    const withCoords = filteredRestaurants.filter((r) => r.lat && r.lng);

    for (const r of withCoords) {
        const infCount = r.totalInfractions;
        let statClass = "map-popup__stat--success";
        let statLabel = "Clean";
        if (infCount > 0) {
            statClass = infCount >= 5 ? "map-popup__stat--danger" : "map-popup__stat--warn";
            statLabel = `${infCount} infraction${infCount !== 1 ? "s" : ""}`;
        }

        // Color the marker based on infractions
        let hue = 120; // green
        if (infCount > 0) hue = infCount >= 5 ? 0 : 40; // red or amber

        const icon = L.divIcon({
            className: "",
            html: `<div style="
                width: 14px; height: 14px;
                background: hsl(${hue}, 70%, 50%);
                border: 2px solid hsl(${hue}, 70%, 70%);
                border-radius: 50%;
                box-shadow: 0 0 6px hsla(${hue}, 70%, 50%, 0.5);
            "></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7],
            popupAnchor: [0, -10],
        });

        const marker = L.marker([r.lat, r.lng], { icon });

        marker.bindPopup(() => {
            const div = document.createElement("div");
            div.className = "map-popup";
            div.innerHTML = `
                <div class="map-popup__name">${esc(r.name || "Unknown")}</div>
                <div class="map-popup__community">${esc(r.community || "—")}</div>
                <div class="map-popup__address">${esc(r.address || "—")}</div>
                <div class="map-popup__stats">
                    <span class="map-popup__stat">${r.inspections.length} inspections</span>
                    <span class="map-popup__stat ${statClass}">${statLabel}</span>
                </div>
                <span class="map-popup__link">View details →</span>
            `;
            div.querySelector(".map-popup__link").addEventListener("click", () => {
                openDetail(r);
            });
            return div;
        }, { maxWidth: 280 });

        marker.addTo(markerLayer);
    }

    // Fit bounds if we have markers
    if (withCoords.length > 0) {
        const bounds = L.latLngBounds(withCoords.map((r) => [r.lat, r.lng]));
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
    }
}

function switchView(view) {
    currentView = view;

    dom.btnViewList.classList.toggle("view-toggle__btn--active", view === "list");
    dom.btnViewMap.classList.toggle("view-toggle__btn--active", view === "map");

    if (view === "list") {
        dom.resultsGrid.style.display = "";
        dom.loadMoreContainer.style.display =
            displayedCount < filteredRestaurants.length ? "block" : "none";
        dom.mapContainer.style.display = "none";
    } else {
        dom.resultsGrid.style.display = "none";
        dom.loadMoreContainer.style.display = "none";
        dom.mapContainer.style.display = "";
        initMap();
        // Leaflet needs a resize nudge when container was hidden
        setTimeout(() => {
            map.invalidateSize();
            updateMap();
        }, 50);
    }
}

// ─── Boot ─────────────────────────────────────────────────
loadData();
