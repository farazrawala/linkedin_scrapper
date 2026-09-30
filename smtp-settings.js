/**
 * Job Post Finder — SMTP settings form, used by popup.html and table.html.
 * Settings are saved to chrome.storage.local as "smtp".
 * The app password and Groq key are stored encrypted (AES-GCM) in smtp.enc. The AES key is a
 * non-extractable CryptoKey kept in the extension's IndexedDB, so it is never written next to
 * the ciphertext and can't be read out as bytes. Use load()/save() rather than reading
 * storage directly.
 * The page needs the inputs smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, smtpFromName,
 * smtpGroqKey, smtpRelay, the buttons smtpShowPass and smtpSave, a status span smtpMsg,
 * and a <form id="smtpBody">.
 */
const JobScraperSmtp = (() => {
  const DEFAULTS = {
    host: "smtp.gmail.com",
    port: 587,
    secure: "tls",
    user: "",
    pass: "",
    fromName: "",
    groqKey: "",
    relayUrl: "http://localhost/linkedin_scrapper/server/send-mail.php",
  };
  // Relay URL used before the project moved to htdocs/linkedin_scrapper.
  const OLD_RELAY_URL = "http://localhost/linkedin_post_job_scrapper/server/send-mail.php";
  const SECRET_FIELDS = ["pass", "groqKey"];

  /** Stored settings merged over the defaults (and the old relay URL updated). */
  function withDefaults(smtp) {
    const v = { ...DEFAULTS, ...(smtp || {}) };
    if (!v.relayUrl || v.relayUrl === OLD_RELAY_URL) v.relayUrl = DEFAULTS.relayUrl;
    delete v.enc;
    return v;
  }

  /** True when the address and app password are both saved (plain or encrypted settings). */
  function isConfigured(smtp) {
    return Boolean(smtp && smtp.user && (smtp.pass || (smtp.enc && smtp.enc.pass)));
  }

  // ---------------------------------------------------------------------------
  // Encryption of the secret fields
  // ---------------------------------------------------------------------------
  const DB_NAME = "jobPostFinder";
  const DB_STORE = "keys";
  const KEY_ID = "smtp";
  let keyPromise = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbRequest(db, mode, run) {
    return new Promise((resolve, reject) => {
      const req = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** The AES key, created on first use. Two pages racing to create it end up with the same one. */
  function getKey() {
    if (!keyPromise) {
      keyPromise = (async () => {
        const db = await openDb();
        try {
          const existing = await dbRequest(db, "readonly", (s) => s.get(KEY_ID));
          if (existing) return existing;
          const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
          try {
            await dbRequest(db, "readwrite", (s) => s.add(key, KEY_ID));
            return key;
          } catch {
            return dbRequest(db, "readonly", (s) => s.get(KEY_ID)); // another page saved one first
          }
        } finally {
          db.close();
        }
      })().catch((err) => {
        keyPromise = null;
        throw err;
      });
    }
    return keyPromise;
  }

  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function encrypt(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getKey(), new TextEncoder().encode(text));
    return { iv: toB64(iv), data: toB64(data) };
  }

  async function decrypt(box) {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, await getKey(), fromB64(box.data));
    return new TextDecoder().decode(plain);
  }

  /** Settings as stored: secret fields removed and put, encrypted, in `enc`. */
  async function seal(smtp) {
    const out = { ...smtp, enc: {} };
    for (const f of SECRET_FIELDS) {
      if (out[f]) out.enc[f] = await encrypt(out[f]);
      delete out[f];
    }
    return out;
  }

  /**
   * Stored settings with the secret fields decrypted.
   * A secret that can't be decrypted (e.g. the key was lost) comes back empty, so it is asked for again.
   * @returns {Promise<{smtp: object, legacy: boolean}>} legacy = plain-text secrets were found
   */
  async function unseal(stored) {
    const smtp = { ...(stored || {}) };
    const enc = smtp.enc || {};
    delete smtp.enc;
    let legacy = false;
    for (const f of SECRET_FIELDS) {
      if (smtp[f]) {
        legacy = true; // saved by an older version in plain text
        continue;
      }
      if (!enc[f]) continue;
      try {
        smtp[f] = await decrypt(enc[f]);
      } catch (err) {
        console.warn(`[JobScraper] Could not decrypt saved ${f}:`, err);
        smtp[f] = "";
      }
    }
    return { smtp, legacy };
  }

  /** Save settings, encrypting the secret fields. */
  async function save(smtp) {
    await chrome.storage.local.set({ smtp: await seal(smtp) });
  }

  /** Saved settings, decrypted and merged over the defaults. Re-saves old plain-text secrets encrypted. */
  async function load() {
    const { smtp: stored } = await chrome.storage.local.get("smtp");
    const { smtp, legacy } = await unseal(stored);
    if (legacy) await save(smtp);
    return withDefaults(smtp);
  }

  /**
   * Wire the form and fill it from storage.
   * @param {{onLoad?: Function, onSaved?: Function}} [hooks] called with the stored settings
   */
  function bind(hooks = {}) {
    const $ = (id) => document.getElementById(id);
    const form = $("smtpBody");
    const msg = $("smtpMsg");
    const fields = { host: $("smtpHost"), port: $("smtpPort"), secure: $("smtpSecure"), user: $("smtpUser"), pass: $("smtpPass"), fromName: $("smtpFromName"), groqKey: $("smtpGroqKey"), relayUrl: $("smtpRelay") };

    $("smtpShowPass").addEventListener("click", () => {
      const show = fields.pass.type === "password";
      fields.pass.type = show ? "text" : "password";
      $("smtpShowPass").textContent = show ? "Hide" : "Show";
    });

    // Pick the usual port when the security mode changes.
    fields.secure.addEventListener("change", () => {
      fields.port.value = fields.secure.value === "ssl" ? 465 : 587;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const smtp = {
        host: fields.host.value.trim() || DEFAULTS.host,
        port: Number(fields.port.value) || DEFAULTS.port,
        secure: fields.secure.value,
        user: fields.user.value.trim(),
        pass: fields.pass.value.replace(/\s+/g, ""), // Google shows app passwords with spaces
        fromName: fields.fromName.value.trim(),
        groqKey: fields.groqKey.value.trim(),
        relayUrl: fields.relayUrl.value.trim() || DEFAULTS.relayUrl,
      };
      if (smtp.user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(smtp.user)) {
        msg.style.color = "#b24020";
        msg.textContent = "Enter a valid email address.";
        return;
      }
      try {
        await save(smtp);
      } catch (err) {
        msg.style.color = "#b24020";
        msg.textContent = `Couldn't save: ${err.message || err}`;
        return;
      }
      fields.pass.value = smtp.pass;
      msg.style.color = "";
      msg.textContent = "Saved ✓";
      setTimeout(() => (msg.textContent = ""), 2000);
      if (hooks.onSaved) hooks.onSaved(smtp);
    });

    function fill(smtp) {
      const v = withDefaults(smtp);
      for (const [k, el] of Object.entries(fields)) el.value = v[k];
    }

    // Stay in sync when another page saves.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.smtp) unseal(changes.smtp.newValue).then(({ smtp }) => fill(smtp));
    });

    load().then((smtp) => {
      fill(smtp);
      if (hooks.onLoad) hooks.onLoad(smtp);
    });
  }

  return { DEFAULTS, withDefaults, isConfigured, load, save, bind };
})();
