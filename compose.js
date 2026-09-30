/**
 * Job Post Finder — "Email" compose dialog on the table page.
 *
 *  - writes a cover email for the job post with Groq (post text + CV text from storage)
 *  - lets you edit it, attaches the saved CV PDF
 *  - sends it through the local PHP relay (server/send-mail.php) with the saved SMTP settings
 * Load smtp-settings.js before this file.
 */
const JobScraperCompose = (() => {
  const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
  const GROQ_MODEL = "openai/gpt-oss-120b";
  const MAX_POST_CHARS = 4000;
  const MAX_CV_CHARS = 6000;

  const $ = (id) => document.getElementById(id);
  const els = {
    dialog: $("composeDialog"),
    title: $("composeTitle"),
    to: $("composeTo"),
    subject: $("composeSubject"),
    body: $("composeBody"),
    attach: $("composeAttach"),
    attachName: $("composeAttachName"),
    file: $("composeFile"),
    filePickLabel: $("composeFilePick"),
    status: $("composeStatus"),
    regen: $("composeRegen"),
    send: $("composeSend"),
    close: $("composeClose"),
    cancel: $("composeCancel"),
  };

  let current = null; // { job, email, onSent }
  let settings = {};
  let cv = null;
  let attachment = null; // { name, type, data }
  let busy = false;

  function setStatus(text, kind = "") {
    els.status.textContent = text;
    els.status.className = `compose-status ${kind}`;
  }

  function setBusy(on) {
    busy = on;
    for (const el of [els.regen, els.send, els.to, els.subject, els.body]) el.disabled = on;
  }

  function showAttachment() {
    els.attach.checked = Boolean(attachment);
    els.attach.disabled = !attachment;
    els.attachName.textContent = attachment ? attachment.name : "No CV PDF saved — choose one →";
    els.filePickLabel.textContent = attachment ? "Change PDF" : "Choose PDF";
  }

  /** Plain fallback when Groq isn't set up or fails. */
  function templateEmail(job) {
    const first = String(job.text || "").split("\n").map((l) => l.trim()).find(Boolean) || "the role";
    const name = settings.fromName || "";
    return {
      subject: `Application: ${first.replace(/\p{Extended_Pictographic}/gu, "").trim().slice(0, 80)}`,
      body: `Hi${job.author ? " " + job.author.split(" ")[0] : ""},\n\nI saw your LinkedIn post about this opening and would like to apply. My CV is attached.\n\nI'd be glad to discuss how I can help.\n\nBest regards,\n${name}`,
    };
  }

  async function generate() {
    const { job } = current;
    if (!settings.groqKey) {
      const t = templateEmail(job);
      els.subject.value = t.subject;
      els.body.value = t.body;
      setStatus("Add your Groq API key in ✉ Email settings to generate a tailored email. Using a basic template.", "warn");
      return;
    }
    setBusy(true);
    setStatus("Writing your email with Groq…");
    try {
      const cvText = cv && cv.text ? cv.text.slice(0, MAX_CV_CHARS) : "";
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.groqKey}` },
        body: JSON.stringify({
          model: GROQ_MODEL,
          temperature: 0.6,
          reasoning_effort: "low",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You write short, professional job application emails in plain text. " +
                'Reply with JSON only: {"subject": string, "body": string}. ' +
                "Body: 120–180 words, greeting the poster by first name if known, saying which role you're applying for, " +
                "2–3 concrete points from the candidate's CV that match the post, a line that the CV is attached, and a sign-off with the candidate's name. " +
                "Use only facts from the CV — never invent experience. No placeholders like [Your Name], no markdown, no emojis.",
            },
            {
              role: "user",
              content:
                `Candidate name: ${settings.fromName || "(unknown)"}\n` +
                `Candidate email: ${settings.user || ""}\n` +
                `Poster: ${job.author || "(unknown)"}\n\n` +
                `JOB POST:\n${String(job.text || "").slice(0, MAX_POST_CHARS)}\n\n` +
                `CANDIDATE CV:\n${cvText || "(no CV saved — keep the email general and don't invent details)"}`,
            },
          ],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.error && data.error.message) || `Groq error ${res.status}`);
      const out = JSON.parse(data.choices[0].message.content);
      if (!out.subject || !out.body) throw new Error("Groq returned an empty email.");
      els.subject.value = String(out.subject).trim();
      els.body.value = String(out.body).trim();
      setStatus(cvText ? "Draft ready — review it before sending." : "Draft ready. Tip: import your CV from the popup for a tailored email.", cvText ? "ok" : "warn");
    } catch (err) {
      console.warn("[compose] Groq failed:", err);
      if (!els.body.value) {
        const t = templateEmail(job);
        els.subject.value = t.subject;
        els.body.value = t.body;
      }
      setStatus(`Couldn't generate with Groq: ${err.message || err}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const to = els.to.value.trim();
    const subject = els.subject.value.trim();
    const body = els.body.value;
    if (!JobScraperSmtp.isConfigured(settings)) {
      setStatus("Save your Gmail address and app password in ✉ Email settings first.", "error");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return setStatus("Enter a valid recipient address.", "error");
    if (!subject || !body.trim()) return setStatus("Subject and message can't be empty.", "error");

    setBusy(true);
    setStatus(`Sending to ${to}…`);
    try {
      const { host, port, secure, user, pass, fromName } = settings;
      const res = await fetch(settings.relayUrl || JobScraperSmtp.DEFAULTS.relayUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smtp: { host, port, secure, user, pass, fromName },
          to,
          subject,
          body,
          attachment: els.attach.checked ? attachment : null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error(`Mail relay answered ${res.status} without JSON. Check the relay URL in Email settings.`);
      if (!data.ok) throw new Error(data.error || "Send failed");
      setStatus(`Sent to ${to} ✓`, "ok");
      if (current.onSent) current.onSent(to);
      setTimeout(() => els.dialog.close(), 1200);
    } catch (err) {
      const msg =
        err instanceof TypeError
          ? "Couldn't reach the mail relay. Check Apache is running, then reload the extension in chrome://extensions and try again."
          : err.message || String(err);
      setStatus(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  els.regen.addEventListener("click", () => !busy && generate());
  els.send.addEventListener("click", () => !busy && send());
  els.close.addEventListener("click", () => els.dialog.close());
  els.cancel.addEventListener("click", () => els.dialog.close());
  els.dialog.addEventListener("cancel", (e) => busy && e.preventDefault());

  // Pick a PDF to attach. It's saved and attached to every email from now on.
  els.file.addEventListener("change", () => {
    const f = els.file.files[0];
    els.file.value = "";
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) return setStatus("That file is over 4 MB — choose a smaller PDF.", "error");
    const reader = new FileReader();
    reader.onload = () => {
      attachment = { name: f.name, type: f.type || "application/pdf", data: String(reader.result).split(",")[1] };
      showAttachment();
      chrome.storage.local
        .set({ cvAttachment: attachment })
        .then(() => setStatus(`${f.name} saved — it will be attached to your emails.`, "ok"))
        .catch((err) => setStatus(`Couldn't save ${f.name}: ${err.message || err}`, "error"));
    };
    reader.readAsDataURL(f);
  });

  /**
   * Open the dialog for a job post and recipient.
   * @param {object} job
   * @param {string} email
   * @param {(to: string) => void} [onSent]
   */
  async function open(job, email, onSent) {
    current = { job, email, onSent };
    const data = await chrome.storage.local.get(["cv", "cvAttachment"]);
    settings = await JobScraperSmtp.load();
    cv = data.cv || null;
    attachment = data.cvAttachment && data.cvAttachment.data ? data.cvAttachment : null;

    els.title.textContent = `Email ${job.author || email}`;
    els.to.value = email;
    els.subject.value = "";
    els.body.value = "";
    showAttachment();
    setStatus("");
    els.dialog.showModal();
    if (!JobScraperSmtp.isConfigured(settings)) {
      setStatus("Tip: save your Gmail SMTP details in ✉ Email settings so you can send from here.", "warn");
    }
    generate();
  }

  return { open };
})();
