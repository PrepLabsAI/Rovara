const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
const login = document.querySelector("#login");
login.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    email: login.elements.email.value, password: login.elements.password.value,
  }) });
  const body = await result.json();
  if (!result.ok) { byId("orders-access-error").textContent = "Unable to sign in"; return; }
  byId("identity").textContent = `${body.displayName} (${body.role})`;
  await refresh();
});
async function refresh() {
  const state = await fetch("/api/orders/state").then((response) => response.json());
  byId("orders-state").textContent = JSON.stringify(state);
}
byId("download-orders").addEventListener("click", async () => {
  const response = await fetch("/api/orders.csv");
  if (!response.ok) { byId("orders-access-error").textContent = `Access refused (${response.status})`; return; }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "orders.csv"; anchor.click(); URL.revokeObjectURL(url);
  byId("orders-export-status").textContent = "Orders exported";
});
