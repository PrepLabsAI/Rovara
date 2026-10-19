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
