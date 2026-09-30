/**
 * Job Post Finder — background service worker.
 * Opens the saved-jobs table in a new tab and seeds default settings on install.
 */

const DEFAULT_SKILLS = [
  "React",
  "React Native",
  "Agentic AI",
  "TypeScript",
  "PostgreSQL",
  "MongoDB",
  "Kafka",
  "AWS",
];

chrome.runtime.onInstalled.addListener(async () => {
  // Only fill in values that don't exist yet, so updates/reloads keep user data.
  const existing = await chrome.storage.local.get([
    "skills",
    "seededSkills",
    "isRunning",
    "jobPosts",
    "postsScanned",
  ]);
  const defaults = {};
  if (!Array.isArray(existing.skills)) {
    defaults.skills = DEFAULT_SKILLS;
  } else {
    // Add defaults that are new since the last update. Defaults seeded before
    // (tracked in seededSkills) are not re-added, so skills the user removed stay removed.
    const seeded = new Set(existing.seededSkills || ["React", "React Native", "Agentic AI"]);
    const have = new Set(existing.skills.map((s) => s.toLowerCase()));
    const added = DEFAULT_SKILLS.filter((s) => !seeded.has(s) && !have.has(s.toLowerCase()));
    if (added.length) defaults.skills = [...existing.skills, ...added];
  }
  defaults.seededSkills = DEFAULT_SKILLS;
  if (typeof existing.isRunning !== "boolean") defaults.isRunning = false;
  if (!Array.isArray(existing.jobPosts)) defaults.jobPosts = [];
  if (typeof existing.postsScanned !== "number") defaults.postsScanned = 0;
  if (Object.keys(defaults).length) await chrome.storage.local.set(defaults);
  console.log("[JobScraper] Installed. Defaults applied:", defaults);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "OPEN_TABLE") {
    chrome.tabs.create({ url: chrome.runtime.getURL("table.html") });
    sendResponse({ ok: true });
  }
  // Returning nothing: response is sent synchronously.
});
