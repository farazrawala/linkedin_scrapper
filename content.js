/**
 * My LinkedIn Scrapper — content script (runs on https://www.linkedin.com/feed/*).
 *
 * While "running":
 *  - scans every post on the feed, expands "…see more", reads the full text
 *  - decides whether the post is a job post (keyword match for now)
 *  - saves job posts to chrome.storage.local ("jobPosts")
 *  - scrolls to the bottom after a random delay (default 1–2 min, set in the popup) (with an on-page countdown)
 *  - a MutationObserver picks up posts added by scrolling
 */
(() => {
  "use strict";

  // Avoid double-initialising if the script is injected twice.
  if (window.__jobScraperLoaded) return;
  window.__jobScraperLoaded = true;

  // ---------------------------------------------------------------------------
  // CONFIG — update selectors here when LinkedIn changes its markup.
  // ---------------------------------------------------------------------------
  const CONFIG = {
    SELECTORS: {
      // Post containers. Tried in order; results are merged and de-duplicated.
      POST: [
        // 2026 LinkedIn feed: <div role="listitem" componentkey="update-card-focus<KEY>FeedType_...">
        '[role="listitem"][componentkey^="update-card-focus"]',
        // Older markup
        'div[data-urn^="urn:li:activity:"]',
        'div[data-id^="urn:li:activity:"]',
        "div.feed-shared-update-v2",
        'div[data-view-name="feed-full-update"]',
      ],
      // "Show more results" button LinkedIn sometimes shows at the end of the feed.
      LOAD_MORE: ["button.scaffold-finite-scroll__load-button"],
      // Attributes that may hold the post URN.
      URN_ATTRIBUTES: ["data-urn", "data-id"],
      // Element holding the post body text (first match wins).
      TEXT: [
        '[data-testid="expandable-text-box"]',
        ".feed-shared-update-v2__description",
        ".update-components-text",
        ".feed-shared-inline-show-more-text",
        ".feed-shared-text",
      ],
      // "…see more" buttons inside the post body.
      SEE_MORE: [
        '[data-testid="expandable-text-button"]',
        "button.feed-shared-inline-show-more-text__see-more-less-toggle",
        "button.see-more",
        'button[aria-label*="see more" i]',
      ],
      // Post key inside the componentkey attribute (2026 feed).
      POST_KEY_ATTRIBUTE: "componentkey",
      POST_KEY_PATTERN: /^update-card-focus(.+?)FeedType/,
      // Buttons whose aria-label ends with the author name, e.g. "Hide post by Adeel Mirza".
      AUTHOR_LABEL: [
        { selector: '[aria-label^="Hide post by "]', prefix: "Hide post by " },
        { selector: '[aria-label^="Open control menu for post by "]', prefix: "Open control menu for post by " },
      ],
      // Author display name (first match wins).
      AUTHOR_NAME: [
        '.update-components-actor__title span[aria-hidden="true"]',
        '.update-components-actor__name span[aria-hidden="true"]',
        ".update-components-actor__title",
        ".update-components-actor__name",
        ".feed-shared-actor__name",
      ],
      // Author profile / company link (first match wins).
      AUTHOR_LINK: [
        "a.update-components-actor__meta-link",
        "a.update-components-actor__image",
        '.update-components-actor__container a[href*="/in/"]',
        '.update-components-actor__container a[href*="/company/"]',
        "a.feed-shared-actor__container-link",
      ],
    },

    // Lowercase keywords that mark a post as a job post.
    JOB_KEYWORDS: [
      "hiring",
      "we're hiring",
      "we are hiring",
      "#hiring",
      "job opening",
      "open position",
      "open role",
      "vacancy",
      "looking for a",
      "join our team",
      "apply now",
      "send your cv",
      "send your resume",
      "dm me your cv",
      "job description",
      "full-time",
      "part-time",
      "remote role",
      "contract role",
      "internship",
      "position available",
      "years of experience",
    ],

    // Auto-scroll after a random delay between these two values.
    SCROLL_MIN_MS: 60000, // 1 min
    SCROLL_MAX_MS: 120000, // 2 min
    SCRAPE_DELAY_AFTER_SCROLL_MS: 3000, // wait for new posts to render
    MUTATION_DEBOUNCE_MS: 1000, // batch DOM mutations before scanning
    SEE_MORE_WAIT_MS: 400, // wait after clicking "see more"
    LINK_MENU_TIMEOUT_MS: 2000, // wait for the "…" menu's "Copy link to post" item
    LINK_COPY_TIMEOUT_MS: 1500, // wait for the copied link after clicking it
    LINK_POLL_MS: 100,
    MAX_PROCESSED_IDS: 5000, // cap on persisted processed IDs

    // Fill matchedSkills when a job post is saved.
    ENABLE_SKILL_MATCHING: true,
  };

  const LOG_PREFIX = "[JobScraper]";
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const processedIds = new Set();
  let isRunning = false;
  let scrollTimeoutId = null;
  let countdownIntervalId = null;
  let nextScrollAt = 0;
  // Scroll limit: popup sets scrollsLeft = scrollLimit on Start; each scroll takes one off.
  const DEFAULT_SCROLL_LIMIT = 10;
  let scrollLimit = DEFAULT_SCROLL_LIMIT;
  let scrollsLeft = null;
  let postsOnPage = -1;
  let scrapeTimeoutId = null;
  let mutationTimeoutId = null;
  let observer = null;
  let scanning = false;
  let rescanRequested = false;
  let skills = [];

  // All storage writes go through this chain so read-modify-write never races.
  let storageQueue = Promise.resolve();
  const enqueueStorage = (fn) => {
    storageQueue = storageQueue.then(fn).catch((err) => warn("Storage error:", err));
    return storageQueue;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** False after the extension is reloaded — the old script must stop. */
  const extensionAlive = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  const isFeedPage = () => location.pathname.startsWith("/feed");

  // ---------------------------------------------------------------------------
  // Job detection — async so it can later be replaced by an AI API call.
  // ---------------------------------------------------------------------------
  /**
   * @param {string} text full post text
   * @returns {Promise<{isJob: boolean, reason: string}>}
   */
  async function isJobPost(text) {
    // Normalise curly apostrophes so "we’re hiring" matches "we're hiring".
    const lower = String(text || "").toLowerCase().replace(/[‘’]/g, "'");
    const matched = CONFIG.JOB_KEYWORDS.filter((kw) => lower.includes(kw));
    if (matched.length) {
      return { isJob: true, reason: `Matched keywords: ${matched.join(", ")}` };
    }
    return { isJob: false, reason: "No job keywords found" };
  }

  // ---------------------------------------------------------------------------
  // Skill matching
  // ---------------------------------------------------------------------------
  /**
   * Case-insensitive whole-word match (shared.js). Async so it can later be
   * replaced by an AI API call.
   * @param {string} text
   * @param {string[]} skillList
   * @returns {Promise<string[]>} matched skills
   */
  async function matchSkills(text, skillList) {
    return JobScraperShared.matchSkills(text, skillList);
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  const queryFirst = (root, selectors) => {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch {
        /* invalid selector in this browser — try the next one */
      }
    }
    return null;
  };

  const collapseWhitespace = (s) => String(s || "").replace(/\s+/g, " ").trim();

  function findPostElements() {
    const found = new Set();
    for (const sel of CONFIG.SELECTORS.POST) {
      document.querySelectorAll(sel).forEach((el) => found.add(el));
    }
    if (found.size) return [...found];
    // None of the selectors match (LinkedIn changed its markup) — find posts by structure.
    return findPostsByActionBar();
  }

  // ---------------------------------------------------------------------------
  // Markup-independent fallback: every post has exactly one "Comment" button in
  // its action bar. Walk up from each one to the largest ancestor that still
  // contains only that one button — that ancestor is the post.
  // ---------------------------------------------------------------------------
  const ACTION_ATTR = "data-jobscraper-action";

  function isCommentButton(el) {
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    if (/^comment( on\b|$)/.test(label)) return true;
    return collapseWhitespace(el.textContent).toLowerCase() === "comment";
  }

  function findPostsByActionBar() {
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(isCommentButton);
    // Tag them so ancestors can be counted cheaply (attribute changes don't trigger our observer).
    buttons.forEach((b) => b.setAttribute(ACTION_ATTR, "1"));
    const posts = new Set();
    for (const btn of buttons) {
      let el = btn;
      while (
        el.parentElement &&
        el.parentElement !== document.body &&
        el.parentElement.querySelectorAll(`[${ACTION_ATTR}]`).length === 1
      ) {
        el = el.parentElement;
      }
      if (el !== btn) posts.add(el);
    }
    return [...posts];
  }

  /**
   * Fallback body finder: the element with the most text that contains neither
   * the action bar nor an avatar link (which marks header / comment blocks).
   */
  function findBodyHeuristic(postEl) {
    let best = null;
    let bestLen = 0;
    for (const el of postEl.querySelectorAll("div, span, p")) {
      const len = el.textContent.length;
      if (len <= bestLen) continue;
      if (el.querySelector(`[${ACTION_ATTR}]`)) continue;
      if (el.querySelector('a[href*="/in/"] img, a[href*="/company/"] img')) continue;
      best = el;
      bestLen = len;
    }
    return best;
  }

  const getBody = (postEl) => queryFirst(postEl, CONFIG.SELECTORS.TEXT) || findBodyHeuristic(postEl);

  /** Small stable hash, used as an ID when a post exposes no URN. */
  function hashText(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  const cleanUrl = (href) => {
    try {
      const u = new URL(href, location.origin);
      return `${u.origin}${u.pathname}`; // strip tracking query params
    } catch {
      return href || "";
    }
  };

  /** https://www.linkedin.com/in/x/ -> .../in/x/recent-activity/all/ ; company -> .../posts/ */
  function authorPostsUrl(authorUrl) {
    if (!authorUrl) return "";
    const base = authorUrl.endsWith("/") ? authorUrl : `${authorUrl}/`;
    if (base.includes("/in/")) return `${base}recent-activity/all/`;
    if (base.includes("/company/")) return `${base}posts/`;
    return base;
  }

  function getUrn(postEl) {
    for (const attr of CONFIG.SELECTORS.URN_ATTRIBUTES) {
      const v = postEl.getAttribute(attr);
      if (v && v.startsWith("urn:li:activity:")) return v;
    }
    // div.feed-shared-update-v2 may not carry the URN itself — check ancestors.
    for (const attr of CONFIG.SELECTORS.URN_ATTRIBUTES) {
      const holder = postEl.closest(`[${attr}^="urn:li:activity:"]`);
      if (holder) return holder.getAttribute(attr);
    }
    // Newer markup: the URN may only appear on a child element or in a post link.
    for (const attr of CONFIG.SELECTORS.URN_ATTRIBUTES) {
      const child = postEl.querySelector(`[${attr}^="urn:li:activity:"]`);
      if (child) return child.getAttribute(attr);
    }
    // Last resort: any post URN anywhere in the post's HTML (attributes, links, JSON).
    const html = postEl.outerHTML.replace(/%3A/gi, ":");
    const m =
      html.match(/urn:li:activity:\d+/) || html.match(/urn:li:ugcPost:\d+/) || html.match(/urn:li:share:\d+/);
    return m ? m[0] : null;
  }

  /** Canonical post URL from a copied/shared LinkedIn link, or "" if it isn't one. */
  function toPostUrl(raw) {
    const s = String(raw || "").replace(/%3A/gi, ":");
    const urn = s.match(/urn:li:(?:activity|ugcPost|share):\d+/);
    if (urn) return `https://www.linkedin.com/feed/update/${urn[0]}/`;
    const act = s.match(/activity-(\d{15,})/);
    if (act) return `https://www.linkedin.com/feed/update/urn:li:activity:${act[1]}/`;
    return /linkedin\.com\/(posts|feed\/update)\//.test(s) ? cleanUrl(s.trim()) : "";
  }

  /**
   * Ask clipboard-hook.js (MAIN world) to read the post URN from React's data.
   * The event is handled synchronously, so the answer is there when dispatchEvent returns.
   */
  const reactUrnOwners = new Map(); // URN -> post id it was first given to

  function getUrnViaReact(postEl) {
    postEl.dispatchEvent(new CustomEvent("job-scraper-find-urn", { bubbles: true }));
    const urn = postEl.getAttribute("data-jobscraper-urn");
    postEl.removeAttribute("data-jobscraper-urn");
    if (urn === null) warn("React URN lookup didn't answer. Is clipboard-hook.js loaded? Reload the LinkedIn tab.");
    return urn && /^urn:li:(activity|ugcPost|share):\d+$/.test(urn) ? urn : "";
  }

  /** Poll for a visible "Copy link to post" menu item. */
  async function waitForCopyLinkItem(timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const items = [...document.querySelectorAll('[role="menuitem"], [role="button"], button, a, li')].filter(
        (el) => /^copy link to post/i.test(collapseWhitespace(el.innerText || el.textContent || ""))
      );
      // Innermost match, so the click lands on the item itself.
      const item = items.find((el) => !items.some((o) => o !== el && el.contains(o)));
      if (item) return item;
      await sleep(CONFIG.LINK_POLL_MS);
    }
    return null;
  }

  /**
   * The 2026 feed doesn't expose post URNs, so open the post's "…" menu and
   * click "Copy link to post". clipboard-hook.js hands the link to us instead
   * of writing it to the user's clipboard. Returns "" on failure.
   */
  async function getPostLinkViaMenu(postEl) {
    const menuBtn = postEl.querySelector(
      '[aria-label^="Open control menu for post by "], button[aria-label*="control menu" i]'
    );
    if (!menuBtn) {
      warn("Post link: no '…' menu button found on the post.");
      return "";
    }

    const root = document.documentElement;
    let onMessage;
    const copied = new Promise((resolve) => {
      onMessage = (e) => {
        if (e.source === window && e.data && e.data.source === "job-scraper-clipboard") resolve(e.data.text);
      };
      window.addEventListener("message", onMessage);
    });

    // Opening a menu can make the page jump; put it back afterwards so this
    // doesn't look like (or interfere with) an auto-scroll.
    const scroller = getScrollTarget();
    const savedTop = scroller.scrollTop;

    root.dataset.jobScraperCapture = "1";
    try {
      menuBtn.click();
      const item = await waitForCopyLinkItem(CONFIG.LINK_MENU_TIMEOUT_MS);
      if (!item) {
        // List what the menu does show, so the item text can be fixed in waitForCopyLinkItem.
        const shown = [...document.querySelectorAll('[role="menuitem"], [role="menu"] li, [role="menu"] button')]
          .map((el) => collapseWhitespace(el.textContent).slice(0, 40))
          .filter(Boolean);
        warn("Post link: menu has no 'Copy link to post' item. Menu items seen:", shown.length ? shown : "(none)");
        return "";
      }
      // Some menus carry the link directly.
      const direct = toPostUrl(item.getAttribute("href") || item.outerHTML);
      if (direct) return direct;
      item.click();
      const text = await Promise.race([copied, sleep(CONFIG.LINK_COPY_TIMEOUT_MS).then(() => "")]);
      if (!text) warn("Post link: clicked 'Copy link to post' but no link was captured.");
      else if (!toPostUrl(text)) warn("Post link: copied text isn't a post URL:", text.slice(0, 120));
      return toPostUrl(text);
    } finally {
      window.removeEventListener("message", onMessage);
      delete root.dataset.jobScraperCapture;
      // Close the menu if it's still open.
      if (menuBtn.getAttribute("aria-expanded") === "true") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        if (menuBtn.getAttribute("aria-expanded") === "true") menuBtn.click();
      }
      if (scroller.scrollTop !== savedTop) scroller.scrollTop = savedTop;
    }
  }

  /** Click "…see more" in the post body if present. Returns true if clicked. */
  async function expandSeeMore(postEl) {
    let btn = queryFirst(postEl, CONFIG.SELECTORS.SEE_MORE);
    if (!btn) {
      // Fallback: any button in the body whose label looks like "…more".
      const body = getBody(postEl) || postEl;
      btn = [...body.querySelectorAll('button, [role="button"]')].find((b) =>
        /^(…|\.\.\.)?\s*(see )?more$/i.test(collapseWhitespace(b.innerText))
      );
    }
    if (!btn || btn.getAttribute("aria-expanded") === "true") return false;
    btn.click();
    await sleep(CONFIG.SEE_MORE_WAIT_MS);
    return true;
  }

  function getPostText(postEl) {
    const body = getBody(postEl);
    const raw = (body || postEl).innerText || "";
    // Drop leftover toggle labels. Keep line breaks (used by location detection and the
    // table), but collapse spaces within lines and runs of blank lines.
    return raw
      .replace(/(…|\.\.\.)\s*(see )?more\b/gi, "")
      .replace(/\bsee less\b/gi, "")
      .split(/\r?\n/)
      .map(collapseWhitespace)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** Stable per-post key from the 2026 feed's componentkey attribute. */
  function getPostKey(postEl) {
    const v = postEl.getAttribute(CONFIG.SELECTORS.POST_KEY_ATTRIBUTE) || "";
    const m = v.match(CONFIG.SELECTORS.POST_KEY_PATTERN);
    return m ? `key:${m[1]}` : null;
  }

  /** Author name from labels like "Hide post by Adeel Mirza". */
  function getAuthorFromLabels(postEl) {
    for (const { selector, prefix } of CONFIG.SELECTORS.AUTHOR_LABEL) {
      const el = postEl.querySelector(selector);
      const name = el ? collapseWhitespace(el.getAttribute("aria-label").slice(prefix.length)) : "";
      if (name) return name;
    }
    return "";
  }

  function getAuthor(postEl) {
    // 2026 feed: name from the "Hide post by …" label, link = the profile/company link with that name.
    const labelName = getAuthorFromLabels(postEl);
    if (labelName) {
      const lower = labelName.toLowerCase();
      const profileLink = [...postEl.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')].find((a) => {
        const label = (a.getAttribute("aria-label") || "").toLowerCase();
        return collapseWhitespace(a.textContent).toLowerCase().startsWith(lower) || label.includes(lower);
      });
      return { author: labelName, authorUrl: profileLink ? cleanUrl(profileLink.href) : "" };
    }

    const nameEl = queryFirst(postEl, CONFIG.SELECTORS.AUTHOR_NAME);
    // innerText can repeat the name (visible + screen-reader copy); take line 1.
    let author = nameEl ? collapseWhitespace((nameEl.innerText || "").split("\n")[0]) : "";
    const linkEl = queryFirst(postEl, CONFIG.SELECTORS.AUTHOR_LINK);
    let authorUrl = linkEl && linkEl.href ? cleanUrl(linkEl.href) : "";
    if (author) return { author, authorUrl };

    // Fallback: first named profile/company link that isn't a "X likes this" line.
    const activityLine = /likes this|loves this|commented|reposted|celebrates|supports this|finds this|is curious|reacted/i;
    for (const a of postEl.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')) {
      const name = collapseWhitespace((a.innerText || "").split("\n")[0]);
      if (!name) continue;
      if (activityLine.test(a.parentElement ? a.parentElement.textContent : "")) continue;
      author = name;
      authorUrl = cleanUrl(a.href);
      break;
    }
    return { author, authorUrl };
  }

  // ---------------------------------------------------------------------------
  // Scraping
  // ---------------------------------------------------------------------------
  /**
   * Process one post. Returns a job object, null for a non-job post,
   * or undefined if the post should be retried later (not rendered yet).
   */
  async function processPost(postEl) {
    const urn = getUrn(postEl);
    // Prefer the URN, then the feed's componentkey; hash the text as a last resort.
    const earlyId = urn || getPostKey(postEl);
    if (earlyId && processedIds.has(earlyId)) return undefined;

    await expandSeeMore(postEl);
    const text = getPostText(postEl);
    if (!text) return undefined; // lazy-loaded placeholder / no text; try again next scan

    const id = earlyId || `text:${hashText(text)}`;
    if (processedIds.has(id)) return undefined;
    processedIds.add(id);

    const { isJob, reason } = await isJobPost(text);
    if (!isJob) return null;

    const { author, authorUrl } = getAuthor(postEl);
    // 1. URN in the HTML, 2. URN from React's data (instant), 3. "Copy link to post" menu.
    let postUrn = urn || getUrnViaReact(postEl);
    if (postUrn && !urn) {
      // A URN that another post already got is shared feed data, not this post's.
      const owner = reactUrnOwners.get(postUrn);
      if (owner && owner !== id) {
        warn("Post link: React gave the same URN as another post, ignoring it:", postUrn);
        postUrn = "";
      } else {
        reactUrnOwners.set(postUrn, id);
      }
    }
    let postUrl = postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : "";
    if (!postUrl) {
      try {
        postUrl = await getPostLinkViaMenu(postEl);
      } catch (err) {
        warn("Couldn't get post link from the menu:", err);
      }
    }
    const job = {
      id,
      author,
      authorUrl,
      text,
      // If even the menu fails, link to the author's recent posts, where this post will be near the top.
      link: postUrl || authorPostsUrl(authorUrl),
      linkIsExact: Boolean(postUrl),
      authorPostsUrl: authorPostsUrl(authorUrl),
      location: JobScraperShared.extractLocation(text),
      scrapedAt: new Date().toISOString(),
      matchedSkills: [],
    };
    if (CONFIG.ENABLE_SKILL_MATCHING) {
      job.matchedSkills = await matchSkills(text, skills);
    }
    log("Job post found:", author || "(unknown author)", "-", reason, job.link || "(no link)");
    return job;
  }

  /** Scan all posts currently in the DOM. Re-entrant calls are coalesced. */
  async function scanPosts() {
    if (!isRunning || !isFeedPage()) return;
    if (!extensionAlive()) return shutdown();
    if (scanning) {
      rescanRequested = true;
      return;
    }
    scanning = true;

    try {
      const posts = findPostElements();
      if (posts.length !== postsOnPage) {
        postsOnPage = posts.length;
        if (postsOnPage === 0) warn("No posts found on the page — CONFIG.SELECTORS.POST may need updating.");
        renderOverlay();
        publishStatus();
      }
      const newJobs = [];
      let scanned = 0;

      for (const postEl of posts) {
        if (!isRunning) break;
        try {
          const result = await processPost(postEl);
          if (result === undefined) continue;
          scanned++;
          if (result) newJobs.push(result);
        } catch (err) {
          warn("Failed to process a post, skipping:", err);
        }
      }

      if (scanned > 0) {
        log(`Scanned ${scanned} new post(s), ${newJobs.length} job post(s).`);
        await saveResults(newJobs, scanned);
      }
    } catch (err) {
      warn("Scan failed:", err);
    } finally {
      scanning = false;
      if (rescanRequested) {
        rescanRequested = false;
        scanPosts();
      }
    }
  }

  /** Persist new jobs (no duplicates), processed IDs and the scanned counter. */
  function saveResults(newJobs, scannedDelta) {
    return enqueueStorage(async () => {
      if (!extensionAlive()) return;
      const data = await chrome.storage.local.get(["jobPosts", "postsScanned"]);
      const jobPosts = Array.isArray(data.jobPosts) ? data.jobPosts : [];
      const existingIds = new Set(jobPosts.map((j) => j.id));
      for (const job of newJobs) {
        if (!existingIds.has(job.id)) {
          jobPosts.push(job);
          existingIds.add(job.id);
        }
      }
      const ids = [...processedIds].slice(-CONFIG.MAX_PROCESSED_IDS);
      await chrome.storage.local.set({
        jobPosts,
        processedIds: ids,
        postsScanned: (Number(data.postsScanned) || 0) + scannedDelta,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Auto-scroll + observer
  // ---------------------------------------------------------------------------
  /** Popup's "Scroll every X – Y sec" setting (seconds) -> CONFIG. */
  function applyScrollRange(range) {
    const min = Number(range && range.minSec);
    const max = Number(range && range.maxSec);
    if (!(min > 0) || !(max >= min)) return false;
    CONFIG.SCROLL_MIN_MS = min * 1000;
    CONFIG.SCROLL_MAX_MS = max * 1000;
    return true;
  }

  const randomScrollDelay = () =>
    CONFIG.SCROLL_MIN_MS + Math.floor(Math.random() * (CONFIG.SCROLL_MAX_MS - CONFIG.SCROLL_MIN_MS + 1));

  /**
   * The element that actually scrolls the feed. Usually the window, but some
   * LinkedIn layouts scroll an inner container instead, so fall back to the
   * tallest scrollable element on the page.
   */
  function getScrollTarget() {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > window.innerHeight + 50) return root;
    let best = null;
    for (const el of document.querySelectorAll("main, div, section")) {
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && (!best || el.scrollHeight > best.scrollHeight)) best = el;
    }
    return best || root;
  }

  function scrollToBottom() {
    const target = getScrollTarget();
    log("Auto-scrolling to bottom of", target === document.scrollingElement ? "window" : target);
    target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
    // If LinkedIn shows a "Show more results" button at the end, click it.
    const loadMore = queryFirst(document, CONFIG.SELECTORS.LOAD_MORE);
    if (loadMore) {
      log('Clicking "Show more results".');
      loadMore.click();
    }
  }

  function scrollTick() {
    if (!isRunning) return;
    // Not on the feed (LinkedIn is a single-page app): wait, and don't use up a scroll.
    if (!isFeedPage()) return scheduleNextScroll();

    // Count the scroll first, so an error while scrolling can't freeze the countdown.
    scrollsLeft = Math.max(0, (scrollsLeft ?? scrollLimit) - 1);
    saveScrollsLeft();
    try {
      scrollToBottom();
    } catch (err) {
      warn("Scroll failed:", err);
    }
    log(`Scrolled. ${scrollsLeft} scroll(s) left.`);
    flashOverlay(`scrolled ✓ · ${scrollsLeft} scroll${scrollsLeft === 1 ? "" : "s"} left`);
    clearTimeout(scrapeTimeoutId);

    if (scrollsLeft > 0) {
      scrapeTimeoutId = setTimeout(scanPosts, CONFIG.SCRAPE_DELAY_AFTER_SCROLL_MS);
      scheduleNextScroll();
    } else {
      // Last scroll: scan what it loaded, then stop.
      nextScrollAt = 0;
      renderOverlay();
      publishStatus();
      scrapeTimeoutId = setTimeout(finishRun, CONFIG.SCRAPE_DELAY_AFTER_SCROLL_MS);
    }
  }

  /** Scroll limit reached: final scan, then switch the scraper off everywhere. */
  async function finishRun() {
    try {
      while (scanning) await sleep(200); // let a scan in progress finish first
      await scanPosts();
    } catch (err) {
      warn("Final scan failed:", err);
    }
    log("Scroll limit reached. Stopping.");
    stop();
    if (extensionAlive()) chrome.storage.local.set({ isRunning: false }).catch(() => {});
  }

  function saveScrollsLeft() {
    if (!extensionAlive()) return;
    chrome.storage.local.set({ scrollsLeft }).catch((err) => warn("Could not save scrolls left:", err));
  }

  /** Pick a new random delay (SCROLL_MIN_MS–SCROLL_MAX_MS) and start the countdown. */
  function scheduleNextScroll() {
    if (scrollsLeft !== null && scrollsLeft <= 0) return; // limit reached, finishing up
    clearTimeout(scrollTimeoutId);
    const delay = randomScrollDelay();
    nextScrollAt = Date.now() + delay;
    log(`Next scroll in ${Math.round(delay / 1000)}s.`);
    scrollTimeoutId = setTimeout(scrollTick, delay);
    renderOverlay();
    publishStatus();
  }

  /** Share the countdown with the popup. */
  function publishStatus() {
    if (!extensionAlive()) return;
    chrome.storage.local
      .set({ scrollStatus: { nextScrollAt: isRunning ? nextScrollAt : 0, postsOnPage } })
      .catch((err) => warn("Could not save scroll status:", err));
  }

  // ---------------------------------------------------------------------------
  // On-page countdown banner
  // ---------------------------------------------------------------------------
  const OVERLAY_ID = "job-scraper-overlay";

  function renderOverlay() {
    let box = document.getElementById(OVERLAY_ID);
    if (!isRunning) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.id = OVERLAY_ID;
      Object.assign(box.style, {
        position: "fixed",
        top: "8px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        padding: "6px 14px",
        borderRadius: "16px",
        background: "rgba(10, 102, 194, 0.95)",
        color: "#fff",
        font: "600 13px system-ui, -apple-system, 'Segoe UI', sans-serif",
        boxShadow: "0 2px 8px rgba(0,0,0,.25)",
        pointerEvents: "none",
      });
      document.body.appendChild(box);
    }
    const secs = Math.max(0, Math.ceil((nextScrollAt - Date.now()) / 1000));
    const posts = postsOnPage < 0 ? "" : ` · ${postsOnPage} post${postsOnPage === 1 ? "" : "s"} on page`;
    const time = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
    const left = scrollsLeft == null ? "" : ` · ${scrollsLeft} scroll${scrollsLeft === 1 ? "" : "s"} left`;
    const flashing = Date.now() < flashUntil;
    box.textContent = flashing
      ? `My LinkedIn Scrapper · ${flashText}`
      : nextScrollAt === 0 && scrollsLeft === 0
        ? `My LinkedIn Scrapper · last scroll done, finishing up${posts}`
        : `My LinkedIn Scrapper · next scroll in ${time}${left}${posts}`;
    box.style.background = flashing
      ? "rgba(5, 118, 66, 0.95)"
      : postsOnPage === 0
        ? "rgba(178, 64, 32, 0.95)"
        : "rgba(10, 102, 194, 0.95)";
  }

  // Green "scrolled ✓" message shown for a moment after each counted scroll.
  let flashText = "";
  let flashUntil = 0;
  function flashOverlay(text) {
    flashText = text;
    flashUntil = Date.now() + 2500;
    renderOverlay();
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      // Ignore our own countdown banner updating every second.
      const overlay = document.getElementById(OVERLAY_ID);
      if (overlay && mutations.every((m) => overlay === m.target || overlay.contains(m.target))) return;
      clearTimeout(mutationTimeoutId);
      mutationTimeoutId = setTimeout(scanPosts, CONFIG.MUTATION_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(mutationTimeoutId);
  }

  function start() {
    if (isRunning) return;
    isRunning = true;
    if (!(scrollsLeft > 0)) {
      scrollsLeft = scrollLimit;
      saveScrollsLeft();
    }
    log(`Started. ${scrollsLeft} scroll(s) to go.`);
    startObserver();
    scanPosts();
    scheduleNextScroll();
    // Tick the on-page countdown once a second.
    countdownIntervalId = setInterval(renderOverlay, 1000);
  }

  function stop() {
    const wasRunning = isRunning;
    isRunning = false;
    clearTimeout(scrollTimeoutId);
    clearTimeout(scrapeTimeoutId);
    clearInterval(countdownIntervalId);
    scrollTimeoutId = null;
    scrapeTimeoutId = null;
    countdownIntervalId = null;
    nextScrollAt = 0;
    stopObserver();
    renderOverlay(); // removes the banner
    if (wasRunning) {
      publishStatus();
      log("Stopped.");
    }
  }

  const setRunning = (value) => (value ? start() : stop());

  /** Called when the extension was reloaded/removed under us. */
  function shutdown() {
    warn("Extension context lost — stopping. Reload the page to reconnect.");
    stop();
  }

  // ---------------------------------------------------------------------------
  // Messages + storage sync
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg?.type === "START") setRunning(true);
      else if (msg?.type === "STOP") setRunning(false);
      sendResponse({ ok: true, isRunning, onFeed: isFeedPage() });
    } catch (err) {
      warn("Message handling failed:", err);
      sendResponse({ ok: false, error: String(err) });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // Keeps multiple feed tabs in sync with the popup's toggle.
    // Read the new count before a Start in the same write (popup sends both together).
    if (changes.scrollLimit) scrollLimit = changes.scrollLimit.newValue || DEFAULT_SCROLL_LIMIT;
    if (changes.scrollsLeft) scrollsLeft = changes.scrollsLeft.newValue ?? null;
    if (changes.isRunning) setRunning(Boolean(changes.isRunning.newValue));
    if (changes.skills) skills = changes.skills.newValue || [];
    // New scroll interval: restart the countdown so it applies right away.
    if (changes.scrollRange && applyScrollRange(changes.scrollRange.newValue) && isRunning) scheduleNextScroll();
    // "Clear Data" in the popup wipes processed IDs — forget them in memory too.
    if (changes.processedIds) {
      const next = changes.processedIds.newValue;
      if (!Array.isArray(next) || next.length === 0) {
        processedIds.clear();
        log("Processed IDs cleared.");
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  (async function init() {
    try {
      const data = await chrome.storage.local.get(["isRunning", "processedIds", "skills", "scrollRange", "scrollLimit", "scrollsLeft"]);
      scrollLimit = data.scrollLimit || DEFAULT_SCROLL_LIMIT;
      scrollsLeft = data.scrollsLeft ?? null; // a page reload mid-run carries on with the count
      applyScrollRange(data.scrollRange);
      (data.processedIds || []).forEach((id) => processedIds.add(id));
      skills = data.skills || [];
      log(`Loaded. ${processedIds.size} previously processed post(s). Running: ${Boolean(data.isRunning)}`);
      if (data.isRunning) start();
    } catch (err) {
      warn("Init failed:", err);
    }
  })();
})();
