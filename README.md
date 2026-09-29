# My LinkedIn Scrapper (Chrome Extension, Manifest V3)

Scans your LinkedIn feed, detects job posts using keywords, and saves them (with links) to a table stored inside the extension. While running, it scrolls to the bottom of the feed after a random delay (default 1–2 minutes, adjustable in the popup) so more posts load. A countdown banner at the top of the feed shows when the next scroll happens.

Job posts are matched against your skills, which are shown in the table and the CSV.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one with `manifest.json`).
4. Pin **My LinkedIn Scrapper** from the puzzle-piece menu (optional).
5. Open (or reload) `https://www.linkedin.com/feed/` while logged in.

> If the feed tab was already open before you loaded or reloaded the extension, reload the tab so the content script attaches.

## Usage

1. Click the extension icon to open the popup.
2. Edit **Skills** if you like: type a skill and press Enter or comma. Click × (or press Backspace in an empty field) to remove one. The defaults are React, React Native, Agentic AI, TypeScript, PostgreSQL, MongoDB, Kafka and AWS. New defaults are added to your saved list when the extension updates. Skills you removed are not added back.
3. Click **Start**. The scraper:
   - scans every visible post straight away, then picks up new posts as they load (MutationObserver)
   - scrolls to the bottom after a random delay (default 1–2 min, set under "Scroll every" in the popup; new delay each time) and scans again about 3 s later
   - shows a banner at the top of the feed: "next scroll in 25s · 12 posts on page". It turns red if no posts are found, which means the selectors need updating
4. Watch **Posts scanned** / **Job posts saved** update live.
5. **Open Table** shows all saved jobs (newest first) with search, "show more" toggles and CSV export.
6. **Export CSV** downloads the saved jobs. **Clear Data** wipes saved jobs, processed IDs and counters after you confirm. Skills are kept.
7. **Number of scrolls** (default 10) sets how many times it scrolls before stopping by itself. While it runs, the field is read-only and counts down the scrolls left. At 0 it does a final scan and stops. Change it while stopped.
8. Click **Stop** to stop scrolling and scraping immediately. The next Start begins the count again.

Keep the feed tab open (it can be in the background, but Chrome may slow down timers in hidden tabs).

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `content.js` | Scrapes feed posts, detects jobs, auto-scrolls. **All selectors and keywords are in the `CONFIG` object at the top.** |
| `popup.html/.css/.js` | Skills, Start/Stop, counters, actions |
| `table.html/.js` | Full-page table of saved jobs |
| `shared.js` | CSV export and sort helpers used by the popup and the table |
| `background.js` | Service worker: opens the table and sets default values on install |

## Storage (`chrome.storage.local`)

| Key | Type | Notes |
|---|---|---|
| `skills` | `string[]` | Chip input values |
| `isRunning` | `boolean` | Start/Stop state, shared by the popup and all feed tabs |
| `jobPosts` | `object[]` | `{ id, author, authorUrl, text, link, linkIsExact, scrapedAt, matchedSkills: [] }`, no duplicate IDs. `linkIsExact: false` means LinkedIn did not expose the post URL, so `link` is the author's recent-posts page |
| `processedIds` | `string[]` | Post URNs already scanned (keeps the last 5000) |
| `postsScanned` | `number` | Counter |

## When LinkedIn changes its markup

LinkedIn changes its HTML often. If nothing gets scanned:

1. Open DevTools on the feed and filter the console by `[JobScraper]`.
2. Inspect a post and update `CONFIG.SELECTORS` in `content.js` (post container, text, "see more" button, author name and link).
3. Reload the extension in `chrome://extensions`, then reload the feed tab.

## Import skills from your CV

1. In the popup, click **📄 Import skills from CV (PDF)**. A CV page opens in a new tab.
2. Drop your CV PDF on the page, or click to choose it. The PDF is read on your computer by the bundled pdf.js (`lib/pdfjs`). Nothing is uploaded.
3. Keywords are shown in two groups:
   - **Known skills found in your CV**: terms from `skills-dictionary.js` found anywhere in the CV. Add your own entries to that file.
   - **Listed in your CV's Skills section**: items under headings like "Skills", "Technical Skills", "Tech Stack" or "Technologies", so skills that aren't in the dictionary are picked up too.
4. Untick anything you don't want, then click **Add selected to my skills** or **Replace my skills with selected**.

The CV text is saved as `cv` in storage for later AI matching. Scanned (image-only) PDFs have no text to read. Export your CV from Word or Google Docs instead.

## Location

The table and CSV have a **Location** column filled from the post text, for example "Dubai, UAE · Hybrid" or "Doha, Qatar":
- A labelled value is used first: "📍 …", "Location: …", "Job Location: …", "based in …", "located in …".
- Otherwise it lists up to 3 known places from `location-dictionary.js` (case-sensitive whole words; add your own).
- "Remote", "Hybrid" or "On-site" is added when the post mentions it.

Like skills, it is worked out when the table loads, so posts saved earlier get a location too. The search box also searches locations.

## Skill matching

- Each saved job post is matched against your skills using case-insensitive whole words: "React" matches "React," and "#React" but not "Reactive". The shared code is `matchSkills` in `shared.js`.
- The table and CSV export always use your **current** skills, so posts saved earlier update when you add or remove a skill.
- The table has a **Matched Skills** column and a filter: All posts / Any skill matched / one specific skill.
- `isJobPost(text)` and `matchSkills(text, skills)` in `content.js` are both `async`, so either can be swapped for an AI API call later.
