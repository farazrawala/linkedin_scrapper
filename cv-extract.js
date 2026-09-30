/**
 * Job Post Finder — keyword extraction from CV text.
 * Pure functions (no DOM, no chrome.*), used by cv.js.
 *
 * Two sources of keywords:
 *  1. known skills from SKILL_DICTIONARY (skills-dictionary.js) found anywhere in the CV
 *  2. items listed under the CV's own "Skills" / "Technologies" / "Tech Stack" heading,
 *     so skills that aren't in the dictionary are picked up too
 */
const CvExtract = (() => {
  // A line that starts a skills section, e.g. "TECHNICAL SKILLS", "Tech Stack:", "Skills: React, Node".
  const SKILLS_HEADING =
    /^\s*(technical |core |key |professional |relevant )?(skills|skill set|skillset|technologies|tech stack|technical expertise|expertise|competencies|core competencies|tools(?: (?:&|and) technologies)?)\b\s*:?\s*(.*)$/i;

  // A line that starts some other section (ends the skills section).
  const OTHER_HEADING =
    /^\s*(experience|work experience|professional experience|employment(?: history)?|work history|education|academic|projects|personal projects|key projects|certifications?|licenses|achievements|accomplishments|awards|languages|interests|hobbies|summary|professional summary|profile|about me|objective|references|publications|volunteer(?:ing)?|contact|courses|training)\s*:?\s*$/i;

  const STOPWORDS = new Set(["and", "etc", "others", "other", "more", "e.g", "i.e", "including", "with", "using", "basic", "advanced", "intermediate", "familiar"]);

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /**
   * Whole-word test; "word" chars are letters/digits so "C++", ".NET" and "CI/CD" still work.
   * A match can't start right after a dot, so "JS" doesn't match inside "Node.js".
   */
  function containsTerm(text, term, caseSensitive) {
    const flags = caseSensitive ? "" : "i";
    return new RegExp(`(^|[^A-Za-z0-9.])${escapeRegex(term)}([^A-Za-z0-9]|$)`, flags).test(text);
  }

  /** Canonical names of dictionary skills that appear in the text. */
  function findKnownSkills(text, dictionary) {
    const found = [];
    for (const entry of dictionary || []) {
      const terms = [entry.name, ...(entry.aliases || [])];
      if (terms.some((t) => containsTerm(text, t, entry.caseSensitive))) found.push(entry.name);
    }
    return found;
  }

  /** Split one skills-section line into individual items. */
  function splitSkillLine(line) {
    let s = line;
    // "Frontend: React, Vue" -> "React, Vue"
    const colon = s.indexOf(":");
    if (colon > -1 && colon < 40) s = s.slice(colon + 1);
    // "React (Hooks, Redux)" -> "React, Hooks, Redux"
    s = s.replace(/[()[\]{}]/g, ",");
    return s
      .split(/[,;|•·▪●◦■♦➢►✓•‣◦⁃∙]|\s{2,}|\t|\s-\s|\s–\s/)
      .map((t) => t.replace(/^[\s\-–*>]+|[\s.\-–*]+$/g, "").replace(/^(and|or)\s+/i, "").trim())
      .filter((t) => {
        if (t.length < 2 || t.length > 40) return false;
        if (t.split(/\s+/).length > 4) return false; // a sentence, not a skill
        if (/^\d+([.,]\d+)?\+?$/.test(t)) return false; // plain number
        if (/\d{4}/.test(t) && /\b(19|20)\d{2}\b/.test(t)) return false; // dates
        return !STOPWORDS.has(t.toLowerCase());
      });
  }

  /** Items listed under skills-type headings. */
  function findSkillsSectionItems(lines) {
    const items = [];
    let inSection = false;
    let linesInSection = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const heading = line.length < 80 ? line.match(SKILLS_HEADING) : null;
      if (heading) {
        inSection = true;
        linesInSection = 0;
        if (heading[3]) items.push(...splitSkillLine(heading[3])); // "Skills: React, Node"
        continue;
      }
      if (!inSection) continue;
      if (OTHER_HEADING.test(line) || ++linesInSection > 40) {
        inSection = false;
        continue;
      }
      items.push(...splitSkillLine(line));
    }
    return items;
  }

  /**
   * @param {string} text full CV text with line breaks
   * @param {object[]} dictionary SKILL_DICTIONARY
   * @returns {{known: string[], fromSection: string[]}} de-duplicated, case-insensitively
   */
  function extractKeywords(text, dictionary) {
    const known = findKnownSkills(text, dictionary);
    const seen = new Set(known.map((k) => k.toLowerCase()));
    // Map aliases to their canonical names so "ReactJS" in the skills list isn't listed twice.
    const aliasToName = new Map();
    for (const e of dictionary || []) {
      for (const t of [e.name, ...(e.aliases || [])]) aliasToName.set(t.toLowerCase(), e.name);
    }
    const fromSection = [];
    for (const item of findSkillsSectionItems(text.split(/\r?\n/))) {
      const canonical = aliasToName.get(item.toLowerCase()) || item;
      const key = canonical.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fromSection.push(canonical);
    }
    return { known, fromSection };
  }

  return { extractKeywords, findKnownSkills, findSkillsSectionItems, splitSkillLine, containsTerm };
})();
