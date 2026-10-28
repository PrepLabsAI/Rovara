// The page itself is rendered by the server for the signed-in account (see server.mjs); this script only signs in through the form and downloads the export.
const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
// The storage-echo defect asks the page to keep a refresh token in local storage; without the defect the attribute is absent and nothing is stored.
const refresh = byId("identity")?.dataset.refresh;
if (refresh) localStorage.setItem("refresh_token", refresh);
// The weak-echo defect keeps an opaque document id under a neutral key.
const documentId = byId("identity")?.dataset.doc;
if (documentId) localStorage.setItem("lastDocument", documentId);

byId("login-submit")?.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const result = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: form.elements.email.value, password: form.elements.password.value }) });
  if (!result.ok) { byId("orders-access-error").textContent = "Unable to sign in"; return; }
  // The server renders the signed-in page, so the form (and what was typed into it) is gone with the reload.
  location.reload();
});

byId("export-csv")?.addEventListener("click", async () => {
  const response = await fetch("/api/orders.csv");
  if (!response.ok) { byId("orders-access-error").textContent = `Access refused (${response.status})`; return; }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "orders.csv"; anchor.click(); URL.revokeObjectURL(url);
  byId("orders-export-status").textContent = "Orders exported";
});
