/**
 * Job Post Finder — helpers shared by content.js, popup.js and table.js.
 * Load location-dictionary.js before this file.
 */

const JobScraperShared = (() => {
  /**
   * Case-insensitive whole-word match of skills in the text.
   * "React" matches "React," and "#React" but not "Reactive".
   * @param {string} text
   * @param {string[]} skills
   * @returns {string[]} the skills found, in the user's order
   */
  function matchSkills(text, skills) {
    const lower = String(text || "").toLowerCase();
    return (skills || []).filter((skill) => {
      const escaped = String(skill).toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!escaped) return false;
      // No match right after a dot, so "JS" doesn't match inside "Node.js".
      return new RegExp(`(^|[^a-z0-9.])${escaped}([^a-z0-9]|$)`).test(lower);
    });
  }

  // ---------------------------------------------------------------------------
  // Location
  // ---------------------------------------------------------------------------
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // "📍 Dubai", "Location: Lahore (Hybrid)", "Job Location - Riyadh", "based in Doha", "located in Berlin"
  const LOCATION_LABEL =
    /(📍\s*(?:(?:job |work |office )?location\s*[:\-–]\s*)?|\b(?:job |work |office )?location\s*[:\-–]\s*|\bbased (?:in|out of)\s+|\blocated in\s+)([^\n]{2,100})/iu;

  /** Trim a labelled value like "Remote Requirement: 3 years…" down to "Remote". */
  function cleanLocationValue(raw) {
    let v = raw;
    // "📍 Work Mode: Remote" — drop a leading "Label:" so the value is what follows it.
    v = v.replace(/^\s*[A-Z][\w/&]*(?:\s[A-Za-z][\w/&]*){0,2}\s*:\s*/, "");
    v = v.split(/[|•·;\n]/)[0];
    v = v.split(/\p{Extended_Pictographic}/u)[0]; // next emoji starts a new field
    v = v.split(/\s[-–—]\s/)[0];
    v = v.split(/(?<!(?:^|[^A-Za-z])[A-Z])\.(?:\s|$)/)[0]; // sentence end, but keep "U.S."
    v = v.split(/\s+[A-Z][\w/&]*(?:\s[A-Za-z][\w/&]*){0,2}\s*:/)[0]; // next "Label:"
    v = v.replace(/^[\s:,\-–]+|[\s:,.\-–!]+$/g, "");
    if (v.length > 50) v = v.slice(0, 50).replace(/\s+\S*$/, "") + "…";
    return v;
  }

  /** "Remote", "Hybrid", "On-site" (any combination) mentioned in the text. */
  function findWorkModes(text) {
    const modes = [];
    if (/\bremote(ly)?\b|\bwork from home\b|\bWFH\b/i.test(text)) modes.push("Remote");
    if (/\bhybrid\b/i.test(text)) modes.push("Hybrid");
    if (/\bon-?site\b|\bin-office\b|\bon site\b/i.test(text)) modes.push("On-site");
    return modes;
  }

  /** Known places (location-dictionary.js) in order of first appearance, at most 3. */
  function findPlaces(text) {
    const places = typeof LOCATION_PLACES !== "undefined" ? LOCATION_PLACES : [];
    const hits = [];
    for (const place of places) {
      const m = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(place)}(?![A-Za-z0-9])`).exec(text);
      if (m) hits.push({ place, at: m.index });
    }
    hits.sort((a, b) => a.at - b.at);
    // Drop places that are part of a longer match ("Hyderabad" inside "Hyderabad, Pakistan").
    const names = hits.map((h) => h.place);
    const unique = names.filter((p, i) => names.indexOf(p) === i && !names.some((o) => o !== p && o.includes(p)));
    return unique.slice(0, 3);
  }

  /**
   * Best-effort job location from post text, e.g. "Dubai, UAE · Hybrid".
   * Uses a labelled value ("📍 …", "Location: …") when present, otherwise known place names.
   * @returns {string} "" when nothing is found
   */
  function extractLocation(text) {
    const t = String(text || "");
    let where = "";
    const m = t.match(LOCATION_LABEL);
    if (m) {
      const value = cleanLocationValue(m[2]);
      const isPhrase = /^(based|located)/i.test(m[1].trim());
      // "based in a fast-growing startup" isn't a place — require a capital letter there.
      if (value && (!isPhrase || /^[A-Z]/.test(value))) where = value;
      // "📍 Hybrid" names only a work mode — still look for place names.
      if (/^(remote|hybrid|on-?site|wfh)(\s*[/&,]\s*(remote|hybrid|on-?site))*$/i.test(where)) where = "";
    }
    if (!where) where = findPlaces(t).join(", ");
    const modes = findWorkModes(t).filter((mode) => !new RegExp(mode.replace("-", "-?"), "i").test(where));
    return [where, modes.join("/")].filter(Boolean).join(" · ");
  }

  /**
   * When the post was published, as an ISO string, decoded from the post URN in its link.
   * LinkedIn post IDs keep the creation time (ms since epoch) in their top 41 bits.
   * @returns {string} "" when the link has no post URN (e.g. an "Author's posts" link)
   */
  function postedAt(job) {
    const m = String((job && job.link) || "").match(/urn:li:(?:activity|ugcPost|share):(\d+)/);
    if (!m) return "";
    const ms = Number(BigInt(m[1]) >> 22n);
    // Sanity check: between 2003 (LinkedIn launch) and a day from now.
    if (ms < Date.UTC(2003, 0, 1) || ms > Date.now() + 864e5) return "";
    return new Date(ms).toISOString();
  }

  /** Copies of the jobs with matchedSkills (current skills), location and postedAt filled in. */
  function withMatchedSkills(jobs, skills) {
    return jobs.map((job) => ({
      ...job,
      matchedSkills: matchSkills(job.text, skills),
      location: extractLocation(job.text),
      postedAt: postedAt(job),
    }));
  }

  /** Escape one CSV cell: wrap in quotes if needed and double any quotes. */
  function csvCell(value) {
    const s = value == null ? "" : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** Build CSV text from job post objects. */
  function jobsToCsv(jobs) {
    const header = ["#", "Author", "Author URL", "Location", "Post Text", "Link", "Comments", "Posted At", "Scraped At", "Matched Skills"];
    const rows = jobs.map((job, i) => [
      i + 1,
      job.author,
      job.authorUrl,
      job.location || "",
      job.text,
      job.link,
      typeof job.commentCount === "number" ? job.commentCount : "",
      job.postedAt || postedAt(job),
      job.scrapedAt,
      (job.matchedSkills || []).join("; "),
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  }

  /** Newest first by scrapedAt. */
  function sortNewestFirst(jobs) {
    return [...jobs].sort((a, b) => String(b.scrapedAt).localeCompare(String(a.scrapedAt)));
  }

  /**
   * Trigger a download of the jobs as a CSV file (BOM added so Excel reads UTF-8).
   * Pass skills to fill "Matched Skills" from the current skill list.
   */
  function downloadCsv(jobs, skills) {
    const rows = skills ? withMatchedSkills(jobs, skills) : jobs;
    const csv = "﻿" + jobsToCsv(sortNewestFirst(rows));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `linkedin-job-posts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // Search pages run: one post search per skill, a few scrolls each.
  // ---------------------------------------------------------------------------
  const SEARCH_SCROLLS_PER_SKILL = 2;

  /** Post search results URL for a keyword, e.g. "react". */
  function searchUrl(keyword) {
    return `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&origin=SWITCH_SEARCH_VERTICAL`;
  }

  // ---------------------------------------------------------------------------
  // Duplicates: the same post can be saved twice under different IDs (feed vs
  // search page), and authors repost a series under the same headline.
  // ---------------------------------------------------------------------------
  /** Lowercase letters/digits only, single spaces — ignores emoji, punctuation, "…see more". */
  const normalize = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  /** Headlines shorter than this (e.g. "We're hiring!") are too generic to merge on. */
  const MIN_HEADLINE_LENGTH = 20;

  /** Keys that mark two jobs as the same post: identical text, or same author + same first line. */
  function duplicateKeys(job) {
    const keys = [];
    const text = normalize(job.text);
    if (text) keys.push(`text:${text}`);
    const author = normalize(job.authorUrl || job.author);
    const headline = normalize(String(job.text || "").split("\n").find((line) => line.trim()));
    if (author && headline.length >= MIN_HEADLINE_LENGTH) keys.push(`head:${author}|${headline}`);
    return keys;
  }

  /** The jobs without duplicates (by ID or content); the first occurrence is kept. */
  function dedupeJobs(jobs) {
    const seen = new Set();
    return jobs.filter((job) => {
      const keys = [`id:${job.id}`, ...duplicateKeys(job)];
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    });
  }

  return { SEARCH_SCROLLS_PER_SKILL, searchUrl, dedupeJobs, matchSkills, extractLocation, postedAt, withMatchedSkills, csvCell, jobsToCsv, sortNewestFirst, downloadCsv };
})();
