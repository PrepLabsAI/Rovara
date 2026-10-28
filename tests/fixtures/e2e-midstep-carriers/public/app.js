// The page is rendered by the server for the signed-in account (see server.mjs); this script signs in through the form and, on a click of a "Sync" button, makes the app acquire a set of values
// mid-step (the MIDSTEP-2 carriers). Every button acquires the same kinds of value; only the one the button names is printed on the page (so the next model call can show exactly one),
// and the `url` button is the only one that puts its value in the address (the address is part of every model prompt, so it would otherwise end every case).
const byId = (id) => document.querySelector(`[data-testid="${id}"]`);

byId("login-submit")?.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const result = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: form.elements.email.value, password: form.elements.password.value }) });
  if (!result.ok) { byId("access-error").textContent = "Unable to sign in"; return; }
  location.reload();
});

function keepInIndexedDb(token) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("appAuthDb", 1);
    open.onupgradeneeded = () => { open.result.createObjectStore("sessions", { keyPath: "id" }); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put({ id: "current", accessToken: token, displayName: "Maya" });
      tx.oncomplete = () => { open.result.close(); resolve(undefined); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function sync(name) {
  const panel = byId("panel");
  const response = await fetch("/api/acquire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ case: name }) });
  if (!response.ok) { panel.textContent = "Sync failed"; return; }
  const set = await response.json();
  // The session cookie was swapped by the response's Set-Cookie. The rest the page keeps itself:
  localStorage.setItem("refresh_token", set.local);
  sessionStorage.setItem("auth_token", set.session);
  localStorage.setItem("app-state", JSON.stringify({ auth: { accessToken: set.json }, ui: { theme: "dark" } }));
  localStorage.setItem("lastDocument", set.weak);
  await keepInIndexedDb(set.idb);
  await fetch("/api/ping", { headers: { Authorization: `Bearer ${set.bearer}` } });
  if (name === "url") history.replaceState(null, "", `/?token=${encodeURIComponent(set.url)}`);
  panel.textContent = name === "control" ? "Synced quietly" : `Synced ${name}: ${set[name]}`;
}

for (const button of document.querySelectorAll("[data-sync]")) button.addEventListener("click", () => { void sync(button.dataset.sync); });
