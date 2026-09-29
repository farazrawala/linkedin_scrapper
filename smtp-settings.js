/**
 * My LinkedIn Scrapper — SMTP settings form, used by popup.html and table.html.
 * Settings are saved to chrome.storage.local as "smtp".
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

  /** Stored settings merged over the defaults (and the old relay URL updated). */
  function withDefaults(smtp) {
    const v = { ...DEFAULTS, ...(smtp || {}) };
    if (!v.relayUrl || v.relayUrl === OLD_RELAY_URL) v.relayUrl = DEFAULTS.relayUrl;
    return v;
  }

  /** True when the address and app password are both saved. */
  function isConfigured(smtp) {
    return Boolean(smtp && smtp.user && smtp.pass);
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
      await chrome.storage.local.set({ smtp });
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
      if (area === "local" && changes.smtp) fill(changes.smtp.newValue);
    });

    chrome.storage.local.get("smtp").then(({ smtp }) => {
      fill(smtp);
      if (hooks.onLoad) hooks.onLoad(smtp);
    });
  }

  return { DEFAULTS, withDefaults, isConfigured, bind };
})();
