const COMIC_VINE_BASE = "https://comicvine.gamespot.com/api";
const SETTINGS_KEY = "comicAppSettings";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

let collection = [];
let issues = [];
let activeFilters = new Set(["to-read"]);
let activeDetailComic = null;
let activeDetailStatus = "to-read";
let activeIssuesComic = null;
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

async function readIssuesFromSheets() {
  const sheetId = getSetting("gsheetId");
  const apiKey = getSetting("gsheetApiKey");

  const resp = await fetch(`${SHEETS_API}/${sheetId}/values/Comic_Issues!A2:H10000?key=${apiKey}`);
  if (!resp.ok) throw new Error(`Issues read failed: ${resp.status}`);
  const data = await resp.json();

  if (!data.values || data.values.length === 0) return [];

  return data.values.map((row) => ({
    id: parseInt(row[0], 10),
    volumeId: parseInt(row[1], 10),
    issueNumber: row[2] || "",
    name: row[3] || "",
    coverDate: row[4] || "",
    image: row[5] || "",
    status: row[6] || "to-read",
    storyArc: row[7] || "",
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

async function writeIssuesToSheets(issuesArray) {
  const sheetId = getSetting("gsheetId");
  const saJson = getSetting("gsheetJson");
  const token = await getAccessToken(saJson);

  const rows = issuesArray.map((i) => [
    i.id, i.volumeId, i.issueNumber, i.name, i.coverDate, i.image, i.status, i.storyArc || "",
  ]);

  await fetch(`${SHEETS_API}/${sheetId}/values/Comic_Issues!A2:H10000:clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (rows.length === 0) return;

  await fetch(`${SHEETS_API}/${sheetId}/values/Comic_Issues!A2:H${rows.length + 1}?valueInputOption=RAW`, {
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

function saveIssues() {
  writeIssuesToSheets(issues).catch((err) => console.error("Issues write failed:", err));
}

async function syncFromSheets() {
  if (!sheetsConfigured()) throw new Error("Google Sheets not configured");
  collection = await readFromSheets();
  try {
    issues = await readIssuesFromSheets();
  } catch {
    issues = [];
  }
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

async function fetchIssuesForVolume(volumeId) {
  const apiKey = getSetting("comicVineKey");
  if (!apiKey) return [];

  const allIssues = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${COMIC_VINE_BASE}/issues/?api_key=${apiKey}&filter=volume:${volumeId}&field_list=id,name,issue_number,cover_date,image&sort=issue_number:asc&limit=${limit}&offset=${offset}`;
    const data = await jsonp(url);

    if (data.status_code !== 1 || !data.results || data.results.length === 0) break;

    for (const issue of data.results) {
      allIssues.push({
        id: issue.id,
        volumeId: volumeId,
        issueNumber: issue.issue_number || "",
        name: issue.name || "",
        coverDate: issue.cover_date || "",
        image: issue.image?.small_url || issue.image?.thumb_url || "",
        status: "to-read",
        storyArc: parseArcFromTitle(issue.name || ""),
      });
    }

    if (allIssues.length >= data.number_of_total_results || data.results.length < limit) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 300));
  }

  return allIssues;
}

async function ensureIssuesLoaded(volumeId) {
  const existing = issues.filter(i => i.volumeId === volumeId);
  if (existing.length > 0) return existing;

  const fetched = await fetchIssuesForVolume(volumeId);
  issues.push(...fetched);
  saveIssues();
  return fetched;
}

function computeComicStatus(volumeId) {
  const volIssues = issues.filter(i => i.volumeId === volumeId);
  if (volIssues.length === 0) return null;
  const statuses = new Set(volIssues.map(i => i.status));
  if (statuses.size === 1) return [...statuses][0];
  return "in-progress";
}

function syncComicStatusFromIssues(volumeId) {
  const newStatus = computeComicStatus(volumeId);
  if (!newStatus) return;
  const comic = collection.find(c => c.id === volumeId);
  if (!comic || comic.status === newStatus) return;
  comic.status = newStatus;
  saveCollection();
  renderCollection();
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
        if (statusFilters.length > 0) {
          // in-progress shows up under to-read filter
          const expanded = [...statusFilters];
          if (expanded.includes("to-read")) expanded.push("in-progress");
          if (!expanded.includes(c.status)) return false;
        }
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
  const labels = { "to-read": "To Read", read: "Read", "didnt-like": "Didn't Like", "in-progress": "In Progress" };
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
  activeDetailStatus = comic.status || "to-read";

  document.getElementById("detail-title").textContent = comic.name;
  document.getElementById("detail-cover").src = comic.image;
  document.getElementById("detail-publisher").textContent = comic.publisher;
  document.getElementById("detail-year").textContent = comic.year;

  // Issues count — clickable link if issues exist or can be loaded
  const issuesEl = document.getElementById("detail-issues");
  const volIssues = issues.filter(i => i.volumeId === comic.id);

  function setIssuesLink() {
    issuesEl.innerHTML = `<button class="issues-link">${comic.issueCount} issues</button>`;
    issuesEl.querySelector(".issues-link").onclick = () => openIssuesModal(comic);
  }

  if (volIssues.length > 0) {
    setIssuesLink();
  } else if (!isNew && getSetting("comicVineKey")) {
    issuesEl.innerHTML = `<span class="issues-loading">loading…</span>`;
    ensureIssuesLoaded(comic.id).then(() => {
      if (activeDetailComic && activeDetailComic.id === comic.id) setIssuesLink();
    }).catch(() => {
      if (activeDetailComic && activeDetailComic.id === comic.id) {
        issuesEl.textContent = `${comic.issueCount} issues`;
      }
    });
  } else {
    issuesEl.textContent = `${comic.issueCount} issues`;
  }

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

  const seriesSpan = document.getElementById("detail-series");
  const seriesSelect = document.getElementById("detail-series-select");
  const currentSeries = comic.series || "Miscellaneous";

  if (isNew) {
    seriesSpan.classList.add("hidden");
    seriesSelect.classList.remove("hidden");
    const existingSeries = [...new Set(
      collection.map(c => c.series || "Miscellaneous").filter(s => s !== "Miscellaneous")
    )].sort();
    seriesSelect.innerHTML = [
      "Miscellaneous",
      ...existingSeries,
    ].map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")
      + `<option value="__new__">New series…</option>`;
    seriesSelect.value = "Miscellaneous";
    seriesSelect.onchange = () => {
      if (seriesSelect.value === "__new__") {
        const name = prompt("Series name:")?.trim();
        if (name) {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          seriesSelect.insertBefore(opt, seriesSelect.lastElementChild);
          seriesSelect.value = name;
        } else {
          seriesSelect.value = "Miscellaneous";
        }
      }
    };
  } else {
    seriesSpan.classList.remove("hidden");
    seriesSelect.classList.add("hidden");
    seriesSpan.textContent = currentSeries;
  }

  setStatusPill(activeDetailStatus);

  const saveBtn = document.getElementById("detail-save");
  saveBtn.textContent = isNew ? "Save to Collection" : "Update";

  const batcaveInput = document.getElementById("detail-batcave-input");
  const batcaveLink = document.getElementById("detail-batcave-link");
  batcaveInput.value = comic.batcaveUrl || "";

  const updateBatcave = (url) => {
    batcaveInput.classList.toggle("hidden", !!url);
    batcaveLink.href = url || "#";
    batcaveLink.classList.toggle("hidden", !url);
  };
  updateBatcave(comic.batcaveUrl);
  batcaveInput.oninput = () => updateBatcave(batcaveInput.value.trim());

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

function openIssuesModal(comic) {
  activeIssuesComic = comic;
  document.getElementById("issues-modal-title").textContent = comic.name;
  const grid = document.getElementById("issues-grid");
  grid.innerHTML = `<p class="issues-loading-msg">Loading issues…</p>`;
  document.getElementById("issues-modal").classList.remove("hidden");

  ensureIssuesLoaded(comic.id).then(() => {
    renderIssuesGrid(comic.id);
  }).catch((err) => {
    grid.innerHTML = `<p class="issues-loading-msg">Failed to load issues.</p>`;
    console.error(err);
  });
}

function parseArcFromTitle(name) {
  if (!name) return "";
  // "Title, Pt. N" or "Title, Pt N"
  let m = name.match(/^(.+?),\s*[Pp]t\.?\s*\d/);
  if (m) return m[1].trim();
  // "Title, Part N"
  m = name.match(/^(.+?),\s*[Pp]art\s+\S/);
  if (m) return m[1].trim();
  // "Title Part N" or "Title Part One/Two/..." (word ordinals)
  m = name.match(/^(.+?)\s+[Pp]art\s+(\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b)/i);
  if (m) return m[1].trim();
  // "Title Chapter N"
  m = name.match(/^(.+?)\s+[Cc]hapter\s+\d/);
  if (m) return m[1].trim();
  // "Title book N"
  m = name.match(/^(.+?)\s+[Bb]ook\s+\d/i);
  if (m) return m[1].trim();
  return "";
}

function renderIssueCard(issue) {
  return `
    <div class="issue-card">
      <img class="issue-cover" src="${issue.image}" alt="" loading="lazy">
      <div class="issue-body">
        <div class="issue-number">#${escapeHtml(issue.issueNumber)}</div>
        ${issue.name ? `<div class="issue-name" title="${escapeHtml(issue.name)}">${escapeHtml(issue.name)}</div>` : ""}
        <span class="status-badge ${issue.status} issue-status" data-issue-id="${issue.id}" title="Click to change">${statusLabel(issue.status)}</span>
      </div>
    </div>
  `;
}

function renderArcCard(arc, arcIssues) {
  const sorted = [...arcIssues].sort((a, b) => parseFloat(a.issueNumber || 0) - parseFloat(b.issueNumber || 0));
  const first = sorted[0];
  const nums = sorted.map(i => parseFloat(i.issueNumber || 0));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = min === max ? `#${first.issueNumber}` : `#${min}–${max}`;
  return `
    <div class="issue-card arc-card" data-arc="${escapeHtml(arc)}" data-collapsed="true">
      <img class="issue-cover" src="${first.image}" alt="" loading="lazy">
      <div class="issue-body">
        <div class="issue-number">${range}</div>
        <div class="issue-name">${escapeHtml(arc)}</div>
        <button class="arc-expand-btn">Expand</button>
      </div>
    </div>
  `;
}

function renderIssuesGrid(volumeId) {
  const grid = document.getElementById("issues-grid");
  const volIssues = issues
    .filter(i => i.volumeId === volumeId)
    .sort((a, b) => parseFloat(a.issueNumber || 0) - parseFloat(b.issueNumber || 0));

  if (volIssues.length === 0) {
    grid.innerHTML = `<p class="issues-loading-msg">No issues found.</p>`;
    return;
  }

  // Group by parsed arc name
  const arcGroups = new Map();
  for (const issue of volIssues) {
    const arc = parseArcFromTitle(issue.name);
    if (!arcGroups.has(arc)) arcGroups.set(arc, []);
    arcGroups.get(arc).push(issue);
  }

  const namedArcs = [...arcGroups.keys()].filter(k => k !== "");

  // No arcs, or all issues belong to one arc — flat grid, no arc cards
  if (namedArcs.length === 0 || (namedArcs.length === 1 && !arcGroups.has(""))) {
    grid.innerHTML = volIssues.map(renderIssueCard).join("");
    return;
  }

  // Interleave arc cards and standalone issues in issue-number order
  const seenArcs = new Set();
  const items = [];
  for (const issue of volIssues) {
    const arc = parseArcFromTitle(issue.name);
    if (arc) {
      if (!seenArcs.has(arc)) {
        seenArcs.add(arc);
        items.push({ type: "arc", arc, issues: arcGroups.get(arc) });
      }
    } else {
      items.push({ type: "issue", issue });
    }
  }

  grid.innerHTML = items.map(item =>
    item.type === "arc"
      ? renderArcCard(item.arc, item.issues)
      : renderIssueCard(item.issue)
  ).join("");
}

function pickRandomUnread() {
  const unread = collection.filter(c => c.status === "to-read" || c.status === "in-progress");
  if (!unread.length) return null;

  const candidates = [];
  const seriesGroups = new Map();

  for (const comic of unread) {
    const key = comic.series && comic.series !== "Miscellaneous" ? comic.series : null;
    if (key) {
      if (!seriesGroups.has(key)) seriesGroups.set(key, []);
      seriesGroups.get(key).push(comic);
    } else {
      candidates.push(comic);
    }
  }

  for (const comics of seriesGroups.values()) {
    comics.sort((a, b) => (parseInt(a.year) || 9999) - (parseInt(b.year) || 9999));
    candidates.push(comics[0]);
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}


function setStatusPill(status) {
  document.querySelectorAll(".status-pill").forEach((p) => {
    p.classList.toggle("active", p.dataset.status === status);
  });
  const inProgressEl = document.getElementById("detail-in-progress");
  if (inProgressEl) inProgressEl.classList.toggle("hidden", status !== "in-progress");
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

  // Filter tabs
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
    pill.addEventListener("click", () => {
      activeDetailStatus = pill.dataset.status;
      setStatusPill(activeDetailStatus);
    });
  });

  // Add button
  document.getElementById("add-btn").addEventListener("click", () => {
    if (!getSetting("comicVineKey")) {
      document.getElementById("settings-modal").classList.remove("hidden");
      return;
    }
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
      document.getElementById("search-reset-btn").classList.remove("hidden");
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
  document.getElementById("search-reset-btn").addEventListener("click", () => {
    document.getElementById("search-input").value = "";
    document.getElementById("search-results").innerHTML = "";
    document.getElementById("search-reset-btn").classList.add("hidden");
    document.getElementById("search-input").focus();
  });
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

  // Random unread picker
  document.getElementById("random-btn").addEventListener("click", () => {
    const comic = pickRandomUnread();
    if (!comic) return;
    openDetail(comic, false);
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

  // Refresh issues for current volume
  document.getElementById("issues-refresh-btn").addEventListener("click", async () => {
    if (!activeIssuesComic) return;
    const grid = document.getElementById("issues-grid");
    grid.innerHTML = `<p class="issues-loading-msg">Refreshing…</p>`;
    try {
      issues = issues.filter(i => i.volumeId !== activeIssuesComic.id);
      await ensureIssuesLoaded(activeIssuesComic.id);
      renderIssuesGrid(activeIssuesComic.id);
    } catch (err) {
      grid.innerHTML = `<p class="issues-loading-msg">Refresh failed.</p>`;
      console.error(err);
    }
  });

  // Issue status click (cycle to-read → read → didnt-like)
  document.getElementById("issues-grid").addEventListener("click", (e) => {
    const arcCard = e.target.closest(".arc-expand-btn, .arc-card > .issue-cover")?.closest(".arc-card");
    if (arcCard) {
      const expandBtn = arcCard.querySelector(".arc-expand-btn");
      const arcName = arcCard.dataset.arc;
      const isCollapsed = arcCard.dataset.collapsed === "true";
      const grid = document.getElementById("issues-grid");

      if (isCollapsed) {
        const arcIssues = issues
          .filter(i => i.volumeId === activeIssuesComic.id && parseArcFromTitle(i.name) === arcName)
          .sort((a, b) => parseFloat(a.issueNumber || 0) - parseFloat(b.issueNumber || 0));
        const temp = document.createElement("template");
        temp.innerHTML = arcIssues.map(renderIssueCard).join("");
        temp.content.querySelectorAll(".issue-card").forEach(card => {
          card.dataset.arcParent = arcName;
        });
        arcCard.after(...temp.content.childNodes);
        arcCard.dataset.collapsed = "false";
        expandBtn.textContent = "Collapse";
      } else {
        grid.querySelectorAll(".issue-card[data-arc-parent]").forEach(el => {
          if (el.dataset.arcParent === arcName) el.remove();
        });
        arcCard.dataset.collapsed = "true";
        expandBtn.textContent = "Expand";
      }
      return;
    }

    const issueName = e.target.closest(".issue-name");
    if (issueName) {
      issueName.classList.toggle("expanded");
      return;
    }

    const badge = e.target.closest(".issue-status");
    if (!badge) return;

    const issueId = parseInt(badge.dataset.issueId, 10);
    const issue = issues.find(i => i.id === issueId);
    if (!issue) return;

    const cycle = ["to-read", "read", "didnt-like"];
    const idx = cycle.indexOf(issue.status);
    issue.status = cycle[(idx + 1) % cycle.length];

    badge.className = `status-badge ${issue.status} issue-status`;
    badge.textContent = statusLabel(issue.status);

    saveIssues();
    syncComicStatusFromIssues(issue.volumeId);
  });

  // Detail save
  document.getElementById("detail-save").addEventListener("click", () => {
    if (!activeDetailComic) return;

    const status = activeDetailStatus;
    const batcaveUrl = document.getElementById("detail-batcave-input").value.trim();
    const favourite = !!activeDetailComic.favourite;
    const idx = collection.findIndex((c) => c.id === activeDetailComic.id);
    const currentStatus = idx >= 0 ? collection[idx].status : activeDetailComic.status;
    const existingIssues = issues.filter(i => i.volumeId === activeDetailComic.id);

    // Warn if changing status and issues exist
    if (existingIssues.length > 0 && status !== currentStatus && status !== "in-progress") {
      if (!confirm(`This will also set all ${existingIssues.length} issues to "${statusLabel(status)}". Continue?`)) return;
      existingIssues.forEach(i => { i.status = status; });
      saveIssues();
    }

    if (idx >= 0) {
      collection[idx].status = status;
      collection[idx].batcaveUrl = batcaveUrl;
      collection[idx].favourite = favourite;
    } else {
      activeDetailComic.status = status;
      activeDetailComic.batcaveUrl = batcaveUrl;
      activeDetailComic.series = document.getElementById("detail-series-select").value;
      activeDetailComic.favourite = favourite;
      collection.push(activeDetailComic);
      // Fetch issues in background for newly added comic
      if (getSetting("comicVineKey")) {
        ensureIssuesLoaded(activeDetailComic.id).catch(console.error);
      }
    }

    document.getElementById("detail-modal").classList.add("hidden");
    document.getElementById("add-modal").classList.add("hidden");
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
