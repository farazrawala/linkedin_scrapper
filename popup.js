/**
 * My LinkedIn Scrapper — popup: skills, start/stop, counters, table/export/clear.
 */

const DEFAULT_SKILLS = ["React", "React Native", "Agentic AI", "TypeScript", "PostgreSQL", "MongoDB", "Kafka", "AWS"];
/** Pages the scraper works on: the feed and post search results. */
const SCRAPE_URL_PREFIXES = ["https://www.linkedin.com/feed", "https://www.linkedin.com/search/results/content"];
const isScrapeUrl = (url) => Boolean(url) && SCRAPE_URL_PREFIXES.some((p) => url.startsWith(p));
const log = (...args) => console.log("[JobScraper]", ...args);

const els = {
  chipBox: document.getElementById("chipBox"),
  skillInput: document.getElementById("skillInput"),
  toggleBtn: document.getElementById("toggleBtn"),
  statusBadge: document.getElementById("statusBadge"),
  tabNote: document.getElementById("tabNote"),
  scrollInfo: document.getElementById("scrollInfo"),
  scannedCount: document.getElementById("scannedCount"),
  savedCount: document.getElementById("savedCount"),
  openTableBtn: document.getElementById("openTableBtn"),
  exportBtn: document.getElementById("exportBtn"),
  clearBtn: document.getElementById("clearBtn"),
  cvBtn: document.getElementById("cvBtn"),
};

let skills = [];
let isRunning = false;
let scrollStatus = { nextScrollAt: 0, postsOnPage: -1 }; // written by content.js

// ---------------------------------------------------------------------------
// Skills section collapse (remembered between popup opens)
// ---------------------------------------------------------------------------
const skillsToggle = document.getElementById("skillsToggle");
const skillsBody = document.getElementById("skillsBody");

function setSkillsCollapsed(collapsed) {
  skillsBody.hidden = collapsed;
  skillsToggle.setAttribute("aria-expanded", String(!collapsed));
  skillsToggle.querySelector(".arrow").textContent = collapsed ? "▸" : "▾";
}

skillsToggle.addEventListener("click", () => {
  const collapsed = !skillsBody.hidden;
  setSkillsCollapsed(collapsed);
  chrome.storage.local.set({ skillsCollapsed: collapsed });
});

// ---------------------------------------------------------------------------
// Scroll interval (seconds, read live by content.js)
// ---------------------------------------------------------------------------
const DEFAULT_SCROLL_RANGE = { minSec: 60, maxSec: 120 };
const scrollMinInput = document.getElementById("scrollMin");
const scrollMaxInput = document.getElementById("scrollMax");

function renderScrollRange(range) {
  scrollMinInput.value = range.minSec;
  scrollMaxInput.value = range.maxSec;
}

function saveScrollRange() {
  const clamp = (v, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 5), 3600) : fallback;
  };
  let minSec = clamp(scrollMinInput.value, DEFAULT_SCROLL_RANGE.minSec);
  let maxSec = clamp(scrollMaxInput.value, DEFAULT_SCROLL_RANGE.maxSec);
  if (minSec > maxSec) [minSec, maxSec] = [maxSec, minSec];
  const range = { minSec, maxSec };
  renderScrollRange(range);
  chrome.storage.local.set({ scrollRange: range });
}

scrollMinInput.addEventListener("change", saveScrollRange);
scrollMaxInput.addEventListener("change", saveScrollRange);

// ---------------------------------------------------------------------------
// Scroll limit: editable while stopped; while running it shows the scrolls
// left (read-only), which content.js counts down to 0 and then stops.
// ---------------------------------------------------------------------------
const DEFAULT_SCROLL_LIMIT = 10;
const scrollLimitInput = document.getElementById("scrollLimit");
const scrollLimitLabel = document.getElementById("scrollLimitLabel");
const scrollLimitUnit = document.getElementById("scrollLimitUnit");
let scrollLimit = DEFAULT_SCROLL_LIMIT;
let scrollsLeft = null;

function renderScrollLimit() {
  scrollLimitInput.readOnly = isRunning;
  scrollLimitInput.title = isRunning ? "Stop to change the number of scrolls" : "";
  scrollLimitLabel.textContent = isRunning ? "Scrolls left" : "Number of scrolls";
  scrollLimitUnit.textContent = isRunning ? "until it stops" : "scrolls, then stop";
  scrollLimitInput.value = isRunning && scrollsLeft != null ? scrollsLeft : scrollLimit;
}

scrollLimitInput.addEventListener("change", () => {
  if (isRunning) return;
  const n = Math.round(Number(scrollLimitInput.value));
  scrollLimit = Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : DEFAULT_SCROLL_LIMIT;
  renderScrollLimit();
  chrome.storage.local.set({ scrollLimit });
});

// ---------------------------------------------------------------------------
// Skills chip input
// ---------------------------------------------------------------------------
function renderSkills() {
  els.chipBox.querySelectorAll(".chip").forEach((c) => c.remove());
  document.getElementById("skillsCount").textContent = `(${skills.length})`;
  for (const skill of skills) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = skill;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = `Remove ${skill}`;
    remove.textContent = "×";
    remove.addEventListener("click", () => removeSkill(skill));

    chip.appendChild(remove);
    els.chipBox.insertBefore(chip, els.skillInput);
  }
}

async function saveSkills() {
  await chrome.storage.local.set({ skills });
  renderSkills();
}

function addSkill(raw) {
  const skill = raw.trim();
  if (!skill) return;
  // Case-insensitive duplicate check.
  if (skills.some((s) => s.toLowerCase() === skill.toLowerCase())) return;
  skills.push(skill);
  saveSkills();
}

function removeSkill(skill) {
  skills = skills.filter((s) => s !== skill);
  saveSkills();
}

els.skillInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addSkill(els.skillInput.value);
    els.skillInput.value = "";
  } else if (e.key === "Backspace" && !els.skillInput.value && skills.length) {
    removeSkill(skills[skills.length - 1]);
  }
});
// Pasting "a, b, c" adds three skills.
els.skillInput.addEventListener("paste", (e) => {
  const text = e.clipboardData.getData("text");
  if (!text.includes(",")) return;
  e.preventDefault();
  text.split(",").forEach(addSkill);
});
els.chipBox.addEventListener("click", () => els.skillInput.focus());

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------
function renderRunning() {
  els.toggleBtn.textContent = isRunning ? "Stop" : "Start";
  els.toggleBtn.classList.toggle("stop", isRunning);
  els.statusBadge.textContent = isRunning ? "Running" : "Stopped";
  els.statusBadge.classList.toggle("running", isRunning);
  renderScrollLimit();
}

/** "Next scroll in 25s · 12 posts on page", refreshed every second. */
function renderScrollInfo() {
  const { nextScrollAt, postsOnPage } = scrollStatus || {};
  if (!isRunning || !nextScrollAt) {
    els.scrollInfo.hidden = true;
    return;
  }
  const secs = Math.max(0, Math.ceil((nextScrollAt - Date.now()) / 1000));
  const time = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
  let text = `Next scroll in ${time}`;
  if (scrollsLeft != null) text += ` · ${scrollsLeft} scroll${scrollsLeft === 1 ? "" : "s"} left`;
  if (postsOnPage >= 0) text += ` · ${postsOnPage} post${postsOnPage === 1 ? "" : "s"} on page`;
  if (postsOnPage === 0) text += " (selectors may need updating)";
  els.scrollInfo.textContent = text;
  els.scrollInfo.classList.toggle("warn", postsOnPage === 0);
  els.scrollInfo.hidden = false;
}
setInterval(renderScrollInfo, 1000);

function showNote(text) {
  els.tabNote.textContent = text || "";
  els.tabNote.hidden = !text;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Tell the content script in the active tab to start/stop. */
async function notifyActiveTab(running) {
  const tab = await getActiveTab();
  if (!tab || !isScrapeUrl(tab.url)) {
    if (running) showNote("Open the LinkedIn feed or a post search in this tab — scraping runs there.");
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: running ? "START" : "STOP" });
    showNote("");
  } catch (err) {
    // Content script isn't there (e.g. tab opened before the extension was loaded).
    log("Content script not reachable:", err);
    showNote("Reload the LinkedIn tab so the scraper can attach.");
  }
}

els.toggleBtn.addEventListener("click", async () => {
  isRunning = !isRunning;
  // Starting resets the countdown to the chosen number of scrolls.
  if (isRunning) scrollsLeft = scrollLimit;
  renderRunning();
  // Storage is the source of truth; content scripts also listen for this change.
  // Both keys go in one write so content.js sees the new count when it starts.
  await chrome.storage.local.set(isRunning ? { isRunning, scrollsLeft } : { isRunning });
  await notifyActiveTab(isRunning);
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------
function renderCounters(postsScanned, jobPosts) {
  els.scannedCount.textContent = Number(postsScanned) || 0;
  els.savedCount.textContent = Array.isArray(jobPosts) ? jobPosts.length : 0;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.postsScanned) els.scannedCount.textContent = Number(changes.postsScanned.newValue) || 0;
  if (changes.jobPosts) {
    const list = changes.jobPosts.newValue;
    els.savedCount.textContent = Array.isArray(list) ? list.length : 0;
  }
  if (changes.scrollsLeft) scrollsLeft = changes.scrollsLeft.newValue ?? null;
  if (changes.scrollLimit) scrollLimit = changes.scrollLimit.newValue || DEFAULT_SCROLL_LIMIT;
  if (changes.isRunning) {
    isRunning = Boolean(changes.isRunning.newValue);
    renderRunning();
  } else if (changes.scrollsLeft || changes.scrollLimit) {
    renderScrollLimit();
  }
  if (changes.scrollStatus) {
    scrollStatus = changes.scrollStatus.newValue || {};
    renderScrollInfo();
  }
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
els.openTableBtn.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "OPEN_TABLE" });
  } catch {
    // Fallback if the service worker is unavailable.
    chrome.tabs.create({ url: chrome.runtime.getURL("table.html") });
  }
});

// Opens in a tab: a file picker opened from the popup can close the popup.
els.cvBtn.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("cv.html") }));

els.exportBtn.addEventListener("click", async () => {
  const { jobPosts = [] } = await chrome.storage.local.get("jobPosts");
  if (!jobPosts.length) {
    alert("No job posts to export yet.");
    return;
  }
  JobScraperShared.downloadCsv(jobPosts, skills);
});

els.clearBtn.addEventListener("click", async () => {
  if (!confirm("Delete all saved job posts, processed post IDs and counters? Your skills are kept.")) return;
  await chrome.storage.local.set({ jobPosts: [], processedIds: [], postsScanned: 0 });
  log("Data cleared.");
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
// Show the extension version from manifest.json.
document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;

(async function init() {
  const data = await chrome.storage.local.get(["skills", "skillsCollapsed", "scrollRange", "scrollLimit", "scrollsLeft", "isRunning", "postsScanned", "jobPosts", "scrollStatus"]);
  // Use defaults only when nothing has ever been saved.
  if (Array.isArray(data.skills)) {
    skills = data.skills;
  } else {
    skills = [...DEFAULT_SKILLS];
    await chrome.storage.local.set({ skills });
  }
  isRunning = Boolean(data.isRunning);
  scrollLimit = data.scrollLimit || DEFAULT_SCROLL_LIMIT;
  scrollsLeft = data.scrollsLeft ?? null;

  setSkillsCollapsed(Boolean(data.skillsCollapsed));
  renderScrollRange(data.scrollRange || DEFAULT_SCROLL_RANGE);
  renderSkills();
  renderRunning();
  renderCounters(data.postsScanned, data.jobPosts);
  scrollStatus = data.scrollStatus || scrollStatus;
  renderScrollInfo();

  const tab = await getActiveTab();
  if (isRunning && (!tab || !isScrapeUrl(tab.url))) {
    showNote("Running, but this tab isn't the LinkedIn feed or a post search.");
  }
})();

// ---------------------------------------------------------------------------
// Email (SMTP) settings — form logic lives in smtp-settings.js.
// ---------------------------------------------------------------------------
(() => {
  const toggle = document.getElementById("smtpToggle");
  const body = document.getElementById("smtpBody");
  const showState = (smtp) => {
    document.getElementById("smtpState").textContent = JobScraperSmtp.isConfigured(smtp) ? `(${smtp.user})` : "(not set)";
  };

  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
    toggle.querySelector(".arrow").textContent = body.hidden ? "▸" : "▾";
  });

  JobScraperSmtp.bind({ onLoad: showState, onSaved: showState });
})();
