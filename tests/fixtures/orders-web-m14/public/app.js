const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
const login = document.querySelector("#login");
login.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    email: login.elements.email.value, password: login.elements.password.value,
  }) });
  await result.json();
  if (!result.ok) { byId("orders-access-error").textContent = "Unable to sign in"; return; }
  byId("orders-access-error").textContent = "";
  await refresh();
});

// Shows the signed-in account (its display name and role only), its tenant's orders with their inventory status,
// and the owner's download buttons. A viewer's buttons stay hidden; the API refuses a viewer's download anyway.
async function refresh() {
  const me = await fetch("/api/me");
  if (!me.ok) return;
  const account = await me.json();
  byId("identity").textContent = `${account.displayName} (${account.role})`;
  const state = await fetch("/api/orders/state").then((response) => response.json());
  byId("orders-state").textContent = JSON.stringify(state);
  const list = await fetch(`/api/tenants/${encodeURIComponent(account.tenantId)}/orders`);
  if (list.ok) {
    const rows = byId("orders-table").querySelector("tbody");
    rows.replaceChildren();
    for (const order of (await list.json()).orders) {
      const row = document.createElement("tr");
      row.setAttribute("data-testid", `order-row-${order.id}`);
      for (const value of [order.id, order.customer, order.total, order.state, order.inventory]) {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        row.append(cell);
      }
      rows.append(row);
    }
    byId("orders-table").hidden = false;
  }
  for (const button of document.querySelectorAll("[data-download]")) button.hidden = account.role !== "owner";
}

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

await refresh();
