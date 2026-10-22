// The page itself is rendered by the server for the signed-in account (see server.mjs); this script only signs in through the form and downloads the export.
const byId = (id) => document.querySelector(`[data-testid="${id}"]`);

byId("login-submit")?.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const result = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    email: form.elements.email.value, password: form.elements.password.value,
  }) });
  if (!result.ok) { byId("orders-access-error").textContent = "Unable to sign in"; return; }
  // The server renders the signed-in page, so the form (and what was typed into it) is gone with the reload.
  location.reload();
});

for (const button of document.querySelectorAll("[data-download]")) {
  button.addEventListener("click", async () => {
    const response = await fetch(button.dataset.download);
    if (!response.ok) { byId("orders-access-error").textContent = `Access refused (${response.status})`; return; }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = button.dataset.filename; anchor.click(); URL.revokeObjectURL(url);
    byId("orders-export-status").textContent = button.dataset.done;
  });
}
