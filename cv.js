/**
 * My LinkedIn Scrapper — CV page: read a PDF CV, extract keywords, save them as skills.
 * The PDF is parsed locally with the bundled pdf.js; nothing leaves the browser.
 */
import * as pdfjsLib from "./lib/pdfjs/pdf.min.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdfjs/pdf.worker.min.js");

const log = (...args) => console.log("[JobScraper]", ...args);
const $ = (id) => document.getElementById(id);

const els = {
  version: $("version"),
  dropZone: $("dropZone"),
  fileInput: $("fileInput"),
  status: $("status"),
  resultCard: $("resultCard"),
  knownChips: $("knownChips"),
  knownCount: $("knownCount"),
  sectionGroup: $("sectionGroup"),
  sectionChips: $("sectionChips"),
  sectionCount: $("sectionCount"),
  addBtn: $("addBtn"),
  replaceBtn: $("replaceBtn"),
  allBtn: $("allBtn"),
  noneBtn: $("noneBtn"),
  toast: $("toast"),
  cvText: $("cvText"),
  mySkills: $("mySkills"),
  skillCount: $("skillCount"),
};

let skills = [];
let keywords = { known: [], fromSection: [] };
const selected = new Set(); // lower-cased keywords the user has ticked

const hasSkill = (k) => skills.some((s) => s.toLowerCase() === k.toLowerCase());

// ---------------------------------------------------------------------------
// PDF -> text
// ---------------------------------------------------------------------------
/** Read all pages, keeping line breaks so section headings can be found. */
async function pdfToText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let out = "";
    let prev = null;
    for (const item of content.items) {
      if (!("str" in item)) continue;
      if (prev) {
        const sameLine = Math.abs(item.transform[5] - prev.transform[5]) < 2;
        if (!sameLine && !out.endsWith("\n")) out += "\n";
        else if (sameLine) {
          // Add a space when there's a visible gap between two pieces on one line.
          const gap = item.transform[4] - (prev.transform[4] + prev.width);
          if (gap > 1 && !out.endsWith(" ") && !item.str.startsWith(" ")) out += " ";
        }
      }
      out += item.str;
      if (item.hasEOL) out += "\n";
      prev = item;
    }
    pages.push(out);
  }
  return { text: pages.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), pages: pdf.numPages };
}

const MAX_CV_ATTACH_BYTES = 4 * 1024 * 1024;

/** ArrayBuffer -> base64 string. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function handleFile(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    setStatus(`"${file.name}" isn't a PDF. Please choose a .pdf file.`, true);
    return;
  }
  setStatus(`Reading ${file.name}…`);
  try {
    const bytes = await file.arrayBuffer();
    // Keep the PDF itself (base64) so it can be attached to emails. pdf.js may detach the buffer, so encode first.
    const fileData = bytes.byteLength <= MAX_CV_ATTACH_BYTES ? toBase64(bytes) : "";
    const { text, pages } = await pdfToText(bytes.slice(0));
    if (text.replace(/\s/g, "").length < 20) {
      setStatus("No text found in this PDF. It may be a scanned image. Export your CV from Word or Google Docs as a PDF and try again.", true);
      return;
    }
    const cv = { fileName: file.name, pages, text, extractedAt: new Date().toISOString() };
    await chrome.storage.local.set({ cv }); // kept for later AI matching
    // The PDF itself, attached to emails from the table page.
    if (fileData) await chrome.storage.local.set({ cvAttachment: { name: file.name, type: "application/pdf", data: fileData } });
    log(`CV read: ${file.name}, ${pages} page(s), ${text.length} chars.`);
    showResults(cv, true);
  } catch (err) {
    log("PDF read failed:", err);
    setStatus(`Couldn't read this PDF: ${err.message || err}`, true);
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function toast(text) {
  els.toast.textContent = text;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (els.toast.textContent = ""), 4000);
}

/** @param {boolean} fresh true right after an upload: pre-select every new keyword */
function showResults(cv, fresh) {
  keywords = CvExtract.extractKeywords(cv.text, SKILL_DICTIONARY);
  if (fresh) {
    selected.clear();
    [...keywords.known, ...keywords.fromSection].forEach((k) => selected.add(k.toLowerCase()));
  }
  const total = keywords.known.length + keywords.fromSection.length;
  setStatus(
    `${cv.fileName} · ${cv.pages} page${cv.pages === 1 ? "" : "s"} · ${total} keyword${total === 1 ? "" : "s"} found` +
      (fresh ? "" : ` (saved ${new Date(cv.extractedAt).toLocaleString()})`)
  );
  els.cvText.textContent = cv.text;
  els.resultCard.hidden = false;
  renderKeywords();
}

function keywordChip(k) {
  const label = document.createElement("label");
  const have = hasSkill(k);
  const checked = have || selected.has(k.toLowerCase());
  label.className = `kw${have ? " have" : checked ? " checked" : ""}`;
  label.title = have ? "Already in your skills" : "";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = have;
  box.addEventListener("change", () => {
    if (box.checked) selected.add(k.toLowerCase());
    else selected.delete(k.toLowerCase());
    renderKeywords();
  });
  label.append(box, document.createTextNode(have ? `${k} ✓` : k));
  return label;
}

function renderKeywords() {
  els.knownChips.replaceChildren(...keywords.known.map(keywordChip));
  els.sectionChips.replaceChildren(...keywords.fromSection.map(keywordChip));
  els.knownCount.textContent = keywords.known.length;
  els.sectionCount.textContent = keywords.fromSection.length;
  els.sectionGroup.hidden = keywords.fromSection.length === 0;
  if (!keywords.known.length) els.knownChips.textContent = "None found.";
  const n = selectedNew().length;
  els.addBtn.textContent = n ? `Add ${n} selected to my skills` : "Add selected to my skills";
  els.addBtn.disabled = n === 0;
}

/** Selected keywords, in display order. */
const selectedAll = () => [...keywords.known, ...keywords.fromSection].filter((k) => selected.has(k.toLowerCase()));
const selectedNew = () => selectedAll().filter((k) => !hasSkill(k));

function renderMySkills() {
  els.skillCount.textContent = skills.length;
  if (!skills.length) {
    els.mySkills.textContent = "No skills yet.";
    return;
  }
  els.mySkills.replaceChildren(
    ...skills.map((s) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = s;
      const x = document.createElement("button");
      x.type = "button";
      x.title = `Remove ${s}`;
      x.textContent = "×";
      x.addEventListener("click", () => saveSkills(skills.filter((k) => k !== s)));
      chip.appendChild(x);
      return chip;
    })
  );
}

async function saveSkills(next) {
  skills = next;
  await chrome.storage.local.set({ skills });
  renderMySkills();
  renderKeywords();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
els.fileInput.addEventListener("change", () => {
  handleFile(els.fileInput.files[0]);
  els.fileInput.value = ""; // allow re-selecting the same file
});

["dragenter", "dragover"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("over");
  })
);
els.dropZone.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

els.addBtn.addEventListener("click", async () => {
  const add = selectedNew();
  if (!add.length) return;
  await saveSkills([...skills, ...add]);
  toast(`Added ${add.length} skill${add.length === 1 ? "" : "s"}.`);
});

els.replaceBtn.addEventListener("click", async () => {
  const next = selectedAll();
  if (!next.length) return toast("Select at least one keyword first.");
  if (!confirm(`Replace your ${skills.length} current skills with the ${next.length} selected keywords?`)) return;
  await saveSkills(next);
  toast(`Your skills are now the ${next.length} selected keywords.`);
});

els.allBtn.addEventListener("click", () => {
  [...keywords.known, ...keywords.fromSection].forEach((k) => selected.add(k.toLowerCase()));
  renderKeywords();
});
els.noneBtn.addEventListener("click", () => {
  selected.clear();
  renderKeywords();
});

// Skills edited in the popup show up here straight away.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.skills) {
    skills = changes.skills.newValue || [];
    renderMySkills();
    renderKeywords();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
els.version.textContent = `v${chrome.runtime.getManifest().version}`;

(async function init() {
  const data = await chrome.storage.local.get(["skills", "cv"]);
  skills = data.skills || [];
  renderMySkills();
  if (data.cv && data.cv.text) showResults(data.cv, false); // show the last CV again
})();
