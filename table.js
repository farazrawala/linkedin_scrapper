/**
 * Job Post Finder — full-page table of saved job posts.
 */

const TRUNCATE_AT = 200;
// Set to false to hide the "Matched Skills" column and filter.
const SHOW_MATCHED_SKILLS = true;

const els = {
  thead: document.getElementById("thead"),
  tbody: document.getElementById("tbody"),
  empty: document.getElementById("empty"),
  search: document.getElementById("search"),
  summary: document.getElementById("summary"),
  exportBtn: document.getElementById("exportBtn"),
  skillFilter: document.getElementById("skillFilter"),
  sortBy: document.getElementById("sortBy"),
};

const SORT_KEY = "jobScraper.sortBy";
try {
  const saved = localStorage.getItem(SORT_KEY);
  if (saved && [...els.sortBy.options].some((o) => o.value === saved)) els.sortBy.value = saved;
} catch {}

/** Sorted copy of the jobs for the chosen sort. Posts without a post date go last. */
function sortJobs(jobs, sortBy) {
  const [field, dir] = sortBy.split("-");
  const sign = dir === "asc" ? 1 : -1;
  const key = (j) =>
    field === "posted" ? j.postedAt || "" : field === "author" ? (j.author || "").toLowerCase() : String(j.scrapedAt || "");
  return [...jobs].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (!ka !== !kb) return ka ? -1 : 1;
    return sign * ka.localeCompare(kb);
  });
}

let allJobs = [];
// { "<job id>|<email>": ISO time } for emails sent from the compose dialog.
let emailsSent = {};
const sentKey = (job, email) => `${job.id || job.link}|${email.toLowerCase()}`;
let skills = [];

/** Fill the skill filter dropdown, keeping the current choice if it still exists. */
function renderSkillFilter() {
  const current = els.skillFilter.value;
  const options = [
    ["", "All posts"],
    ["__any", "Any skill matched"],
    ...skills.map((s) => [s, s]),
  ];
  els.skillFilter.replaceChildren(
    ...options.map(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      return o;
    })
  );
  els.skillFilter.value = options.some(([v]) => v === current) ? current : "";
  els.skillFilter.hidden = !SHOW_MATCHED_SKILLS;
}

// Column labels, also shown above each value in the narrow-screen card layout.
let columns = [];

function renderHeader() {
  const cols = ["#", "Author", "Location", "Post Text", "Link", "Posted At", "Scraped At"];
  if (SHOW_MATCHED_SKILLS) cols.splice(4, 0, "Matched Skills");
  columns = cols;
  const tr = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    tr.appendChild(th);
  }
  els.thead.replaceChildren(tr);
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;

/** Fill `el` with `text`, turning URLs into clickable links. */
function setLinkedText(el, text) {
  const nodes = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    const href = /^https?:\/\//i.test(m[0]) ? m[0] : `https://${m[0]}`;
    const a = link(href, m[0]);
    a.className = "post-link";
    nodes.push(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  el.replaceChildren(...nodes);
}

/** Cut point for truncation, pushed past any URL it would split. */
function truncateIndex(text) {
  for (const m of text.matchAll(URL_RE)) {
    const end = m.index + m[0].length;
    if (m.index < TRUNCATE_AT && end > TRUNCATE_AT) return end;
  }
  return TRUNCATE_AT;
}

const TITLE_MAX = 160;

/** Split off the first line as a title when it's short and more text follows. */
function splitTitle(text) {
  const trimmed = text.trim();
  const nl = trimmed.indexOf("\n");
  if (nl < 0 || nl > TITLE_MAX) return { title: "", body: trimmed };
  return { title: trimmed.slice(0, nl).trim(), body: trimmed.slice(nl + 1).replace(/^\s*\n/, "") };
}

/** Post text cell: a title line, then the body with a "show more / show less" toggle for long text. */
function textCell(fullText) {
  const td = document.createElement("td");
  td.className = "text";
  const { title, body: text } = splitTitle(fullText);
  if (title) {
    const h = document.createElement("div");
    h.className = "post-title";
    setLinkedText(h, title);
    td.appendChild(h);
  }
  const span = document.createElement("span");
  span.className = "post-body";
  td.appendChild(span);

  if (text.length <= TRUNCATE_AT) {
    setLinkedText(span, text);
    return td;
  }

  let expanded = false;
  const btn = document.createElement("button");
  btn.className = "toggle";
  const cut = truncateIndex(text);
  const update = () => {
    setLinkedText(span, expanded ? text : text.slice(0, cut).trimEnd() + "…");
    btn.textContent = expanded ? "show less" : "show more";
  };
  btn.addEventListener("click", () => {
    expanded = !expanded;
    update();
  });
  update();
  td.appendChild(btn);
  return td;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Unique email addresses in the text, lower-cased. */
function findEmails(text) {
  return [...new Set((String(text).match(EMAIL_RE) || []).map((e) => e.replace(/\.+$/, "").toLowerCase()))];
}

function link(href, label) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  return a;
}

/** "just now", "5 min ago", "1 hr ago", "3 days ago", … */
function timeAgo(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  const units = [
    [60 * 24 * 365, "yr"],
    [60 * 24 * 30, "month"],
    [60 * 24 * 7, "week"],
    [60 * 24, "day"],
    [60, "hr"],
    [1, "min"],
  ];
  for (const [size, unit] of units) {
    const n = Math.floor(mins / size);
    if (n >= 1) return `${n} ${unit}${n > 1 && unit !== "min" ? "s" : ""} ago`;
  }
}

// Keep "x ago" current without re-rendering (which would reset "show more").
setInterval(() => {
  for (const td of els.tbody.querySelectorAll("td[data-posted-at]")) td.textContent = timeAgo(td.dataset.postedAt);
}, 60000);

function renderRows() {
  const q = els.search.value.trim().toLowerCase();
  const skill = els.skillFilter.value;
  // Match against the current skills so old posts update when skills change.
  const jobs = JobScraperShared.withMatchedSkills(allJobs, skills);
  const rows = sortJobs(jobs, els.sortBy.value).filter((j) => {
    if (q && !`${j.text} ${j.author} ${j.location}`.toLowerCase().includes(q)) return false;
    if (skill === "__any") return j.matchedSkills.length > 0;
    if (skill) return j.matchedSkills.includes(skill);
    return true;
  });

  const frag = document.createDocumentFragment();
  rows.forEach((job, i) => {
    const tr = document.createElement("tr");

    const num = document.createElement("td");
    num.className = "num";
    num.textContent = i + 1;

    const author = document.createElement("td");
    author.className = "author";
    const name = job.author || "Unknown";
    author.appendChild(job.authorUrl ? link(job.authorUrl, name) : document.createTextNode(name));

    const linkTd = document.createElement("td");
    linkTd.className = "links";
    const actions = document.createElement("div");
    actions.className = "link-actions";
    linkTd.appendChild(actions);
    const actionLink = (href, label, kind) => {
      const a = link(href, label);
      a.className = `act act-${kind}`;
      return a;
    };
    // linkIsExact === false: LinkedIn didn't expose the post URL, so this is the author's posts page.
    if (!job.link) {
      actions.textContent = "—";
      actions.classList.add("muted");
    } else if (job.linkIsExact === false) {
      actions.appendChild(actionLink(job.link, "Author's posts", "secondary"));
    } else {
      actions.appendChild(actionLink(job.link, "Open post", "primary"));
    }
    if (job.linkIsExact === false) linkTd.title = "Exact post link wasn't available — the post will be near the top of this page.";
    else if (job.authorPostsUrl) {
      actions.appendChild(actionLink(job.authorPostsUrl, "Author's posts", "secondary"));
    }

    const posted = document.createElement("td");
    posted.className = "date posted";
    if (job.postedAt) {
      posted.dataset.postedAt = job.postedAt;
      posted.textContent = timeAgo(job.postedAt);
      posted.title = new Date(job.postedAt).toLocaleString();
    } else {
      posted.textContent = "—";
      posted.classList.add("muted");
      posted.title = "Post date is only known when the exact post link was captured.";
    }

    for (const email of findEmails(job.text || "")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "email-btn";
      const sentAt = emailsSent[sentKey(job, email)];
      btn.textContent = sentAt ? "✓ Sent" : "✉ Email";
      btn.classList.toggle("sent", Boolean(sentAt));
      btn.title = sentAt ? `Emailed ${email} on ${new Date(sentAt).toLocaleString()} — click to email again` : `Write and send an email to ${email}`;
      btn.addEventListener("click", () => {
        JobScraperCompose.open(job, email, (to) => {
          emailsSent = { ...emailsSent, [sentKey(job, to)]: new Date().toISOString() };
          chrome.storage.local.set({ emailsSent });
        });
      });
      actions.append(btn);
    }

    const date = document.createElement("td");
    date.className = "date scraped";
    const d = new Date(job.scrapedAt);
    date.textContent = isNaN(d) ? job.scrapedAt || "" : d.toLocaleString();
    date.title = job.scrapedAt || "";

    const loc = document.createElement("td");
    loc.className = "location";
    loc.textContent = job.location || "—";
    if (!job.location) loc.classList.add("muted");

    tr.append(num, author, loc, textCell(job.text || ""));
    if (SHOW_MATCHED_SKILLS) {
      const skillsTd = document.createElement("td");
      skillsTd.className = "skills";
      if (!job.matchedSkills.length) {
        skillsTd.textContent = "—";
        skillsTd.classList.add("muted");
      } else {
        const list = document.createElement("div");
        list.className = "skill-list";
        for (const s of job.matchedSkills) {
          const chip = document.createElement("span");
          chip.className = "skill";
          chip.textContent = s;
          list.appendChild(chip);
        }
        skillsTd.appendChild(list);
      }
      tr.appendChild(skillsTd);
    }
    tr.append(linkTd, posted, date);
    [...tr.children].forEach((td, idx) => {
      if (columns[idx]) td.dataset.label = columns[idx];
    });
    frag.appendChild(tr);
  });

  els.tbody.replaceChildren(frag);
  els.empty.hidden = rows.length > 0;
  els.empty.textContent = allJobs.length ? "No posts match your search." : "No job posts saved yet.";
  els.summary.textContent = q || skill ? `${rows.length} of ${allJobs.length} posts` : `${allJobs.length} posts`;
}

els.search.addEventListener("input", renderRows);
els.skillFilter.addEventListener("change", renderRows);
els.sortBy.addEventListener("change", () => {
  try {
    localStorage.setItem(SORT_KEY, els.sortBy.value);
  } catch {}
  renderRows();
});

els.exportBtn.addEventListener("click", () => {
  if (!allJobs.length) {
    alert("No job posts to export yet.");
    return;
  }
  JobScraperShared.downloadCsv(allJobs, skills);
});

// Live-update while the scraper runs in another tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.jobPosts) allJobs = JobScraperShared.dedupeJobs(changes.jobPosts.newValue || []);
  if (changes.skills) {
    skills = changes.skills.newValue || [];
    renderSkillFilter();
  }
  if (changes.emailsSent) emailsSent = changes.emailsSent.newValue || {};
  if (changes.jobPosts || changes.skills || changes.emailsSent) renderRows();
});

// Email settings dialog.
const smtpBtn = document.getElementById("smtpBtn");
const smtpDialog = document.getElementById("smtpDialog");
const showSmtpState = (smtp) => {
  const set = JobScraperSmtp.isConfigured(smtp);
  smtpBtn.classList.toggle("set", set);
  smtpBtn.title = set ? `Sending as ${smtp.user}` : "Email (SMTP) settings — not set";
};
smtpBtn.addEventListener("click", () => smtpDialog.showModal());
document.getElementById("smtpClose").addEventListener("click", () => smtpDialog.close());
// A click on the backdrop closes the dialog.
smtpDialog.addEventListener("click", (e) => {
  if (e.target === smtpDialog) smtpDialog.close();
});
JobScraperSmtp.bind({
  onLoad: showSmtpState,
  onSaved: (smtp) => {
    showSmtpState(smtp);
    setTimeout(() => smtpDialog.close(), 800);
  },
});

// Show the extension version from manifest.json.
document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;

(async function init() {
  renderHeader();
  const data = await chrome.storage.local.get(["jobPosts", "skills", "emailsSent"]);
  // Hide duplicates saved by older versions; storage is cleaned on the scraper's next save.
  allJobs = JobScraperShared.dedupeJobs(data.jobPosts || []);
  emailsSent = data.emailsSent || {};
  skills = data.skills || [];
  renderSkillFilter();
  renderRows();
})();
