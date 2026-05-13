const COMIC_VINE_BASE = "https://comicvine.gamespot.com/api";
const SETTINGS_KEY = "comicAppSettings";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

let collection = [];
let activeFilters = new Set(["to-read"]);
let activeDetailComic = null;
let jsonpCounter = 0;
let viewMode = localStorage.getItem("viewMode") || "grid";

// --- Settings ---

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function getSetting(key) {
  return loadSettings()[key] || "";
}

function setSetting(key, value) {
  const s = loadSettings();
  s[key] = value;
  saveSettings(s);
}


// --- JSONP (Comic Vine blocks CORS, but supports JSONP) ---

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const callbackName = `_cvCallback${jsonpCounter++}`;
    const script = document.createElement("script");

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Request timed out"));
    }, 15000);

    function cleanup() {
      clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    const separator = url.includes("?") ? "&" : "?";
    script.src = `${url}${separator}format=jsonp&json_callback=${callbackName}`;
    script.onerror = () => {
      cleanup();
      reject(new Error("Network error"));
    };

    document.head.appendChild(script);
  });
}

// --- Google Sheets Auth (Service Account JWT) ---

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeBytes(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(serviceAccountJson) {
  const sa = typeof serviceAccountJson === "string" ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimB64 = base64UrlEncode(JSON.stringify(claim));
  const signInput = `${headerB64}.${claimB64}`;

  const keyData = pemToArrayBuffer(sa.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signInput));
  const jwt = `${signInput}.${base64UrlEncodeBytes(signature)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status}`);
  const data = await resp.json();
  return data.access_token;
}

// --- Google Sheets Read/Write ---

function sheetsConfigured() {
  return getSetting("gsheetId") && getSetting("gsheetApiKey") && getSetting("gsheetJson");
}

async function readFromSheets() {
  const sheetId = getSetting("gsheetId");
  const apiKey = getSetting("gsheetApiKey");

  const resp = await fetch(`${SHEETS_API}/${sheetId}/values/Comics!A2:L1000?key=${apiKey}`);
  if (!resp.ok) throw new Error(`Sheets read failed: ${resp.status}`);
  const data = await resp.json();

  if (!data.values || data.values.length === 0) return [];

  return data.values.map((row) => ({
    id: parseInt(row[0], 10),
    name: row[1] || "",
    publisher: row[2] || "",
    year: row[3] || "",
    issueCount: parseInt(row[4], 10) || 0,
    image: row[5] || "",
    status: row[6] || "to-read",
    dateAdded: row[7] || "",
    batcaveUrl: row[8] || "",
    favourite: row[9] === "true",
    series: row[10] || "Miscellaneous",
    description: row[11] || "",
  }));
}

async function writeToSheets(comics) {
  const sheetId = getSetting("gsheetId");
  const saJson = getSetting("gsheetJson");
  const token = await getAccessToken(saJson);

  const rows = comics.map((c) => [
    c.id, c.name, c.publisher, c.year, c.issueCount, c.image, c.status, c.dateAdded, c.batcaveUrl || "", c.favourite ? "true" : "false", c.series || "Miscellaneous", c.description || "",
  ]);

  await fetch(`${SHEETS_API}/${sheetId}/values/Comics!A2:L1000:clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (rows.length === 0) return;

  await fetch(`${SHEETS_API}/${sheetId}/values/Comics!A2:L${rows.length + 1}?valueInputOption=RAW`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });
}

function saveCollection() {
  writeToSheets(collection).catch((err) => console.error("Sheets write failed:", err));
}

async function syncFromSheets() {
  if (!sheetsConfigured()) throw new Error("Google Sheets not configured");
  collection = await readFromSheets();
  renderCollection();
  return collection.length;
}

// --- Comic Vine API ---

async function searchVolumes(query) {
  const apiKey = getSetting("comicVineKey");
  if (!apiKey) throw new Error("NO_API_KEY");

  const url = `${COMIC_VINE_BASE}/search/?api_key=${apiKey}&resources=volume&query=${encodeURIComponent(query)}&field_list=id,name,count_of_issues,publisher,start_year,image,deck`;
  const data = await jsonp(url);

  if (data.error === "Invalid API Key") throw new Error("INVALID_API_KEY");
  if (data.status_code !== 1) throw new Error(data.error || "Search failed");

  return data.results || [];
}

function stripHtml(html) {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.textContent || el.innerText || "";
}

async function fetchDescription(comicId) {
  const apiKey = getSetting("comicVineKey");
  if (!apiKey) return "";
  try {
    const data = await jsonp(`${COMIC_VINE_BASE}/volume/4050-${comicId}/?api_key=${apiKey}&field_list=description`);
    return (data.status_code === 1 && data.results?.description) ? data.results.description : "";
  } catch {
    return "";
  }
}

// --- Rendering ---

function renderCollection() {
  const grid = document.getElementById("collection-grid");
  const empty = document.getElementById("empty-state");

  const filtered = activeFilters.size === 0
    ? collection
    : collection.filter((c) => {
        if (activeFilters.has("favourites") && !c.favourite) return false;
        const statusFilters = [...activeFilters].filter(f => f !== "favourites");
        if (statusFilters.length > 0 && !statusFilters.includes(c.status)) return false;
        return true;
      });

  if (collection.length === 0) {
    empty.classList.remove("hidden");
    grid.innerHTML = "";
    return;
  }

  empty.classList.add("hidden");

  if (filtered.length === 0) {
    grid.innerHTML = `<p style="color:#666; grid-column:1/-1; text-align:center; padding:2rem;">No comics with this status.</p>`;
    return;
  }

  // Group by series
  const groups = new Map();
  for (const comic of filtered) {
    const key = comic.series && comic.series !== "" ? comic.series : "Miscellaneous";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(comic);
  }

  // Sort groups A-Z, Miscellaneous last
  const keys = [...groups.keys()].filter(k => k !== "Miscellaneous").sort((a, b) => a.localeCompare(b));
  if (groups.has("Miscellaneous")) keys.push("Miscellaneous");

  // Sort within each group: Miscellaneous A-Z by title, others by release year
  for (const key of keys) {
    if (key === "Miscellaneous") {
      groups.get(key).sort((a, b) => a.name.localeCompare(b.name));
    } else {
      groups.get(key).sort((a, b) => (parseInt(a.year) || 9999) - (parseInt(b.year) || 9999));
    }
  }

  grid.className = viewMode === "grid" ? "collection-grid" : "collection-list";

  grid.innerHTML = keys.map(key => `
    <div class="series-divider"><span>${escapeHtml(key)}</span></div>
    ${groups.get(key).map(comic => viewMode === "grid" ? `
      <div class="comic-card" data-id="${comic.id}">
        <button class="card-favourite ${comic.favourite ? "is-favourite" : ""}" data-id="${comic.id}">&#9733;</button>
        <img class="cover" src="${comic.image}" alt="${escapeHtml(comic.name)}" loading="lazy">
        <div class="card-body">
          <div class="card-title">${escapeHtml(comic.name)}</div>
          <div class="card-meta">${escapeHtml(comic.publisher)} · ${comic.issueCount} issues · ${comic.year}</div>
          <span class="status-badge ${comic.status}">${statusLabel(comic.status)}</span>
        </div>
      </div>
    ` : `
      <div class="comic-list-item" data-id="${comic.id}">
        <img class="list-thumb" src="${comic.image}" alt="" loading="lazy">
        <div class="list-info">
          <div class="list-title">${escapeHtml(comic.name)}</div>
          <div class="list-meta">${escapeHtml(comic.publisher)} · ${comic.year} · ${comic.issueCount} issues</div>
        </div>
        <span class="status-badge ${comic.status}">${statusLabel(comic.status)}</span>
        <button class="card-favourite ${comic.favourite ? "is-favourite" : ""}" data-id="${comic.id}">&#9733;</button>
      </div>
    `).join("")}
  `).join("");
}

function statusLabel(status) {
  const labels = { "to-read": "To Read", read: "Read", "didnt-like": "Didn't Like" };
  return labels[status] || status;
}

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str || "";
  return el.innerHTML;
}

function renderSearchResults(results) {
  const container = document.getElementById("search-results");

  if (results.length === 0) {
    container.innerHTML = `<p class="loading">No results found.</p>`;
    return;
  }

  container.innerHTML = results
    .map((vol) => {
      const inCollection = collection.some((c) => c.id === vol.id);
      const thumb = vol.image?.thumb_url || "";
      const publisher = vol.publisher?.name || "Unknown";
      return `
      <div class="search-result-item" data-volume='${escapeAttr(JSON.stringify(vol))}'>
        <img src="${thumb}" alt="">
        <div class="result-info">
          <div class="result-title">${escapeHtml(vol.name)}</div>
          <div class="result-meta">${escapeHtml(publisher)} · ${vol.count_of_issues || "?"} issues · ${vol.start_year || "?"}</div>
          ${inCollection ? '<div class="in-collection">Already in collection</div>' : ""}
        </div>
      </div>
    `;
    })
    .join("");
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Detail Modal ---

function openDetail(comic, isNew) {
  activeDetailComic = comic;

  document.getElementById("detail-title").textContent = comic.name;
  document.getElementById("detail-cover").src = comic.image;
  document.getElementById("detail-publisher").textContent = comic.publisher;
  document.getElementById("detail-year").textContent = comic.year;
  document.getElementById("detail-issues").textContent = comic.issueCount + " issues";

  function renderDescription(html) {
    const descEl = document.getElementById("detail-description");
    if (!html) { descEl.classList.add("hidden"); return; }
    const plain = stripHtml(html);
    const LIMIT = 200;
    if (plain.length <= LIMIT) {
      descEl.textContent = plain;
      descEl.onclick = null;
    } else {
      descEl.innerHTML = escapeHtml(plain.slice(0, LIMIT).trim()) + '… <span style="color:#fff">read more</span>';
      descEl.onclick = () => openSynopsis(comic.name, html);
    }
    descEl.classList.remove("hidden");
  }

  renderDescription(comic.description || "");

  if (!comic.description && getSetting("comicVineKey")) {
    fetchDescription(comic.id).then((desc) => {
      if (desc) {
        comic.description = desc;
        renderDescription(desc);
        saveCollection();
      }
    });
  }

  const seriesSelect = document.getElementById("detail-series-input");
  const currentSeries = comic.series || "Miscellaneous";
  seriesSelect.innerHTML = getSeriesList().map(s =>
    `<option value="${escapeHtml(s)}"${s === currentSeries ? " selected" : ""}>${escapeHtml(s)}</option>`
  ).join("");

  setStatusPill(comic.status || "to-read");

  const saveBtn = document.getElementById("detail-save");
  saveBtn.textContent = isNew ? "Save to Collection" : "Update";

  const batcaveInput = document.getElementById("detail-batcave-input");
  const batcaveLink = document.getElementById("detail-batcave-link");
  batcaveInput.value = comic.batcaveUrl || "";

  if (comic.batcaveUrl) {
    batcaveInput.classList.add("hidden");
    batcaveLink.href = comic.batcaveUrl;
    batcaveLink.classList.remove("hidden");
  } else {
    batcaveInput.classList.remove("hidden");
    batcaveLink.classList.add("hidden");
  }

  batcaveInput.addEventListener("input", () => {
    const val = batcaveInput.value.trim();
    if (val) {
      batcaveLink.href = val;
      batcaveLink.classList.remove("hidden");
    } else {
      batcaveLink.classList.add("hidden");
    }
  });

  document.getElementById("detail-modal").classList.remove("hidden");
}

function volumeToComic(vol, status) {
  return {
    id: vol.id,
    name: vol.name || "Untitled",
    publisher: vol.publisher?.name || "Unknown",
    year: vol.start_year || "?",
    issueCount: vol.count_of_issues || 0,
    image: vol.image?.medium_url || vol.image?.small_url || "",
    status: status || "to-read",
    dateAdded: new Date().toISOString(),
    description: vol.description || "",
    series: "Miscellaneous",
  };
}

function openSynopsis(title, html) {
  document.getElementById("synopsis-title").textContent = title;
  document.getElementById("synopsis-body").innerHTML = html;
  document.getElementById("synopsis-modal").classList.remove("hidden");
}

function getSeriesList() {
  const set = new Set(collection.map(c => c.series).filter(s => s && s !== "Miscellaneous"));
  return ["Miscellaneous", ...[...set].sort()];
}

function setStatusPill(status) {
  document.querySelectorAll(".status-pill").forEach((p) => {
    p.classList.toggle("active", p.dataset.status === status);
  });
}

function getStatusPill() {
  return document.querySelector(".status-pill.active")?.dataset.status || "to-read";
}

function setSheetsStatus(msg, type) {
  const el = document.getElementById("sheets-status");
  el.textContent = msg;
  el.className = "settings-status " + (type || "");
}

// --- Events ---

document.addEventListener("DOMContentLoaded", async () => {
  if (sheetsConfigured()) {
    try {
      await syncFromSheets();
    } catch (err) {
      console.error("Failed to load from Sheets:", err);
    }
  }
  renderCollection();

  // Filter tabs (multi-select, but Favourites is mutually exclusive)
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = btn.dataset.filter;
      if (f === "favourites") {
        if (activeFilters.has("favourites")) {
          activeFilters.delete("favourites");
          btn.classList.remove("active");
        } else {
          activeFilters.clear();
          document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
          activeFilters.add("favourites");
          btn.classList.add("active");
        }
      } else {
        activeFilters.delete("favourites");
        document.querySelector('.filter-btn[data-filter="favourites"]').classList.remove("active");
        if (activeFilters.has(f)) {
          activeFilters.delete(f);
          btn.classList.remove("active");
        } else {
          activeFilters.add(f);
          btn.classList.add("active");
        }
      }
      renderCollection();
    });
  });

  // Status pills in detail modal
  document.querySelectorAll(".status-pill").forEach((pill) => {
    pill.addEventListener("click", () => setStatusPill(pill.dataset.status));
  });

  // Add button
  document.getElementById("add-btn").addEventListener("click", () => {
    if (!getSetting("comicVineKey")) {
      document.getElementById("settings-modal").classList.remove("hidden");
      return;
    }
    document.getElementById("search-input").value = "";
    document.getElementById("search-results").innerHTML = "";
    document.getElementById("add-modal").classList.remove("hidden");
    document.getElementById("search-input").focus();
  });

  // Settings button
  document.getElementById("settings-btn").addEventListener("click", () => {
    document.getElementById("api-key-input").value = getSetting("comicVineKey");
    document.getElementById("gsheet-id-input").value = getSetting("gsheetId");
    document.getElementById("gsheet-api-key-input").value = getSetting("gsheetApiKey");
    document.getElementById("gsheet-json-input").value = getSetting("gsheetJson");
    setSheetsStatus("");
    document.getElementById("settings-modal").classList.remove("hidden");
  });

  // Save settings
  document.getElementById("save-settings").addEventListener("click", () => {
    setSetting("comicVineKey", document.getElementById("api-key-input").value.trim());
    setSetting("gsheetId", document.getElementById("gsheet-id-input").value.trim());
    setSetting("gsheetApiKey", document.getElementById("gsheet-api-key-input").value.trim());
    setSetting("gsheetJson", document.getElementById("gsheet-json-input").value.trim());
    setSheetsStatus("Settings saved.", "success");
  });

  // Sync now
  document.getElementById("sync-now-btn").addEventListener("click", async () => {
    // Save settings first
    setSetting("comicVineKey", document.getElementById("api-key-input").value.trim());
    setSetting("gsheetId", document.getElementById("gsheet-id-input").value.trim());
    setSetting("gsheetApiKey", document.getElementById("gsheet-api-key-input").value.trim());
    setSetting("gsheetJson", document.getElementById("gsheet-json-input").value.trim());

    if (!sheetsConfigured()) {
      setSheetsStatus("Fill in all Google Sheets fields first.", "error");
      return;
    }

    setSheetsStatus("Syncing...");

    try {
      const count = await syncFromSheets();
      setSheetsStatus(`Synced. ${count} comic${count !== 1 ? "s" : ""} in sheet.`, "success");
    } catch (err) {
      setSheetsStatus(`Sync failed: ${err.message}`, "error");
    }
  });

  // Search
  async function doSearch() {
    const query = document.getElementById("search-input").value.trim();
    if (!query) return;

    const results = document.getElementById("search-results");
    results.innerHTML = `<p class="loading">Searching...</p>`;

    try {
      const volumes = await searchVolumes(query);
      renderSearchResults(volumes);
    } catch (err) {
      if (err.message === "NO_API_KEY") {
        results.innerHTML = `<p class="loading">Set your API key in Settings first.</p>`;
      } else if (err.message === "INVALID_API_KEY") {
        results.innerHTML = `<p class="loading">Invalid API key. Check Settings.</p>`;
      } else {
        results.innerHTML = `<p class="loading">Search failed: ${escapeHtml(err.message)}</p>`;
      }
    }
  }

  document.getElementById("search-btn").addEventListener("click", doSearch);
  document.getElementById("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  // Click search result
  document.getElementById("search-results").addEventListener("click", (e) => {
    const item = e.target.closest(".search-result-item");
    if (!item) return;

    const vol = JSON.parse(item.dataset.volume);
    const existing = collection.find((c) => c.id === vol.id);

    if (existing) {
      openDetail(existing, false);
    } else {
      const comic = volumeToComic(vol, "to-read");
      openDetail(comic, true);
    }
  });

  // View toggle
  const viewToggleBtn = document.getElementById("view-toggle-btn");
  viewToggleBtn.innerHTML = viewMode === "grid" ? "&#9776;" : "&#9635;";
  viewToggleBtn.title = viewMode === "grid" ? "List view" : "Grid view";
  viewToggleBtn.addEventListener("click", () => {
    viewMode = viewMode === "grid" ? "list" : "grid";
    localStorage.setItem("viewMode", viewMode);
    viewToggleBtn.innerHTML = viewMode === "grid" ? "&#9776;" : "&#9635;";
    viewToggleBtn.title = viewMode === "grid" ? "List view" : "Grid view";
    renderCollection();
  });

  // Click collection card (grid or list)
  document.getElementById("collection-grid").addEventListener("click", (e) => {
    const starBtn = e.target.closest(".card-favourite");
    if (starBtn) {
      const id = parseInt(starBtn.dataset.id, 10);
      const comic = collection.find((c) => c.id === id);
      if (comic) {
        comic.favourite = !comic.favourite;
        starBtn.classList.toggle("is-favourite", comic.favourite);
        saveCollection();
      }
      return;
    }

    const card = e.target.closest(".comic-card, .comic-list-item");
    if (!card) return;

    const id = parseInt(card.dataset.id, 10);
    const comic = collection.find((c) => c.id === id);
    if (comic) openDetail(comic, false);
  });

  // Detail save
  document.getElementById("detail-save").addEventListener("click", () => {
    if (!activeDetailComic) return;

    const status = getStatusPill();
    const batcaveUrl = document.getElementById("detail-batcave-input").value.trim();
    const favourite = !!activeDetailComic.favourite;
    const series = document.getElementById("detail-series-input").value || "Miscellaneous";
    const idx = collection.findIndex((c) => c.id === activeDetailComic.id);

    if (idx >= 0) {
      collection[idx].status = status;
      collection[idx].batcaveUrl = batcaveUrl;
      collection[idx].favourite = favourite;
      collection[idx].series = series;
    } else {
      activeDetailComic.status = status;
      activeDetailComic.batcaveUrl = batcaveUrl;
      activeDetailComic.favourite = favourite;
      activeDetailComic.series = series;
      collection.push(activeDetailComic);
    }

    document.getElementById("detail-modal").classList.add("hidden");
    saveCollection();
    renderCollection();
  });

  // Close modals
  document.querySelectorAll(".close-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".modal").classList.add("hidden");
    });
  });

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });
  });
});
