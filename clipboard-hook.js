/**
 * Runs in the page's MAIN world. While content.js is capturing a post link
 * (<html data-job-scraper-capture="1">), LinkedIn's "Copy link to post" write
 * is sent to content.js via postMessage instead of the clipboard, so the
 * user's clipboard is left untouched.
 */
(() => {
  if (window.__jobScraperClipboardHook) return;
  window.__jobScraperClipboardHook = true;

  const capturing = () => document.documentElement.dataset.jobScraperCapture === "1";
  const send = (text) => window.postMessage({ source: "job-scraper-clipboard", text: String(text || "") }, "*");

  const clip = navigator.clipboard;
  if (clip && clip.writeText) {
    const origWriteText = clip.writeText.bind(clip);
    clip.writeText = (text) => {
      if (!capturing()) return origWriteText(text);
      send(text);
      return Promise.resolve();
    };
  }
  if (clip && clip.write) {
    const origWrite = clip.write.bind(clip);
    clip.write = async (items) => {
      if (!capturing()) return origWrite(items);
      for (const item of items || []) {
        if (item.types && item.types.includes("text/plain")) {
          send(await (await item.getType("text/plain")).text());
          break;
        }
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Post URN lookup from React's internal data.
  // content.js (isolated world) can't see React's properties on DOM nodes, but this
  // MAIN-world script can. content.js dispatches "job-scraper-find-urn" on a post;
  // DOM events run synchronously across worlds, so the answer is written to
  // data-jobscraper-urn before dispatchEvent() returns.
  // ---------------------------------------------------------------------------
  const URN_RE = /urn:li:(?:activity|ugcPost|share):\d+/;
  const SKIP_KEYS = new Set(["_owner", "_debugOwner", "return", "_store", "stateNode", "alternate"]);

  /** Depth-limited search of an object graph for the first post URN string. */
  function scanForUrn(value, depth, seen, budget) {
    if (budget.left-- <= 0) return null;
    if (typeof value === "string") {
      const m = value.match(URN_RE);
      return m ? m[0] : null;
    }
    if (!value || typeof value !== "object" || depth <= 0 || seen.has(value)) return null;
    if (value instanceof Node || value === window) return null;
    seen.add(value);
    const keys = Array.isArray(value) ? value.keys() : Object.keys(value);
    let n = 0;
    for (const k of keys) {
      if (++n > 60) break;
      if (SKIP_KEYS.has(k)) continue;
      let child;
      try {
        child = value[k];
      } catch {
        continue;
      }
      const found = scanForUrn(child, depth - 1, seen, budget);
      if (found) return found;
    }
    return null;
  }

  const reactKeys = (el) => Object.keys(el).filter((k) => k.startsWith("__reactProps$") || k.startsWith("__reactFiber$"));

  function findUrnInReact(postEl) {
    const seen = new WeakSet();
    const budget = { left: 20000 };
    // 1. Components that render this post (between its DOM node and the parent DOM node).
    //    Going further up would reach the feed list, which holds every post's URN.
    for (const k of reactKeys(postEl)) {
      if (!k.startsWith("__reactFiber$")) continue;
      for (let f = postEl[k]; f; f = f.return) {
        if (f !== postEl[k] && f.stateNode instanceof Element) break;
        const found = scanForUrn(f.memoizedProps, 6, seen, budget);
        if (found) return found;
      }
    }
    // 2. Props of the post's own DOM nodes (outermost first, so a reshared inner post loses).
    const nodes = [postEl, ...postEl.querySelectorAll("*")].slice(0, 600);
    for (const el of nodes) {
      for (const k of reactKeys(el)) {
        const target = k.startsWith("__reactFiber$") ? el[k] && el[k].memoizedProps : el[k];
        const found = scanForUrn(target, 5, seen, budget);
        if (found) return found;
      }
      if (budget.left <= 0) break;
    }
    return null;
  }

  /**
   * Debug helper — run jobScraperDebug() in the LinkedIn tab's console.
   * Lists, per post, every URN found in React's data and where, plus the one picked.
   */
  window.jobScraperDebug = function jobScraperDebug(limit = 8) {
    const posts = [...document.querySelectorAll('[role="listitem"][componentkey^="update-card-focus"]')].slice(0, limit);
    const rows = posts.map((post, i) => {
      const hide = post.querySelector('[aria-label^="Hide post by "]');
      const author = hide ? hide.getAttribute("aria-label").replace("Hide post by ", "") : "?";
      const found = [];
      const collect = (value, where, depth) => {
        const seen = new WeakSet();
        const budget = { left: 20000 };
        const walk = (v, d) => {
          if (budget.left-- <= 0) return;
          if (typeof v === "string") {
            const m = v.match(new RegExp(URN_RE.source, "g"));
            if (m) m.forEach((u) => found.push(`${u} (${where})`));
            return;
          }
          if (!v || typeof v !== "object" || d <= 0 || seen.has(v) || v instanceof Node || v === window) return;
          seen.add(v);
          let n = 0;
          for (const k of Array.isArray(v) ? v.keys() : Object.keys(v)) {
            if (++n > 60) break;
            if (SKIP_KEYS.has(k)) continue;
            try {
              walk(v[k], d - 1);
            } catch {}
          }
        };
        walk(value, depth);
      };
      for (const k of reactKeys(post)) {
        if (!k.startsWith("__reactFiber$")) continue;
        let level = 0;
        for (let f = post[k]; f; f = f.return, level++) {
          if (f !== post[k] && f.stateNode instanceof Element) break;
          collect(f.memoizedProps, `component ${level}`, 6);
        }
      }
      [...post.querySelectorAll("*")].slice(0, 600).forEach((el, j) => {
        for (const k of reactKeys(el)) collect(k.startsWith("__reactFiber$") ? el[k] && el[k].memoizedProps : el[k], `child ${j}`, 5);
      });
      const picked = findUrnInReact(post);
      return { i, author, picked, found: [...new Set(found)].slice(0, 12).join("\n") || "(none)" };
    });
    console.table(rows);
    return rows;
  };

  document.addEventListener(
    "job-scraper-find-urn",
    (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      let urn = null;
      try {
        urn = findUrnInReact(el);
      } catch (err) {
        console.warn("[JobScraper] React URN lookup failed:", err);
      }
      el.setAttribute("data-jobscraper-urn", urn || "");
    },
    true
  );

  // Older copy path: hidden textarea + document.execCommand("copy").
  const origExec = document.execCommand.bind(document);
  document.execCommand = (cmd, ...rest) => {
    if (!capturing() || String(cmd).toLowerCase() !== "copy") return origExec(cmd, ...rest);
    const el = document.activeElement;
    send(el && "value" in el ? el.value : String(window.getSelection()));
    return true;
  };
})();
