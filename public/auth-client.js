/* Passkey ceremonies for setup, login, and add-passkey pages.
 * Uses the vendored SimpleWebAuthnBrowser bundle (loaded before this file). */
(function () {
  "use strict";

  function show(el, message, isError) {
    el.textContent = message;
    el.classList.toggle("text-danger", !!isError);
    el.classList.remove("hidden");
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
    return data;
  }

  async function register(optionsUrl, verifyUrl, payload, statusEl) {
    const opts = await post(optionsUrl, payload);
    const attResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: opts.options });
    return post(verifyUrl, {
      response: attResp,
      challengeId: opts.challengeId,
      name: payload.name || "",
      setupToken: payload.setupToken || "",
    });
  }

  // --- Setup page ---
  const setupForm = document.getElementById("setup-form");
  if (setupForm) {
    setupForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      const status = document.getElementById("setup-status");
      const token = document.getElementById("setup-token").value.trim();
      const name = document.getElementById("setup-passkey-name").value.trim() || "My passkey";
      try {
        show(status, "Follow your browser's passkey prompt…");
        await register("/setup/webauthn/options", "/setup/webauthn/verify", { setupToken: token, name: name }, status);
        show(status, "Passkey created. Redirecting…");
        window.location.href = "/app";
      } catch (err) {
        show(status, err.message, true);
      }
    });
  }

  // --- Login page ---
  const loginBtn = document.getElementById("login-button");
  if (loginBtn) {
    loginBtn.addEventListener("click", async function () {
      const status = document.getElementById("login-status");
      try {
        show(status, "Follow your browser's passkey prompt…");
        const opts = await post("/login/webauthn/options", {});
        const authResp = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: opts.options });
        const result = await post("/login/webauthn/verify", { response: authResp, challengeId: opts.challengeId });
        window.location.href = result.returnTo || "/app";
      } catch (err) {
        show(status, err.message, true);
      }
    });
  }

  // --- Add passkey (management UI) ---
  const addForm = document.getElementById("add-passkey-form");
  if (addForm) {
    addForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      const status = document.getElementById("add-passkey-status");
      const name = document.getElementById("add-passkey-name").value.trim() || "Unnamed passkey";
      try {
        show(status, "Follow your browser's passkey prompt…");
        await register("/app/passkeys/options", "/app/passkeys/verify", { name: name }, status);
        window.location.reload();
      } catch (err) {
        show(status, err.message, true);
      }
    });
  }
})();
