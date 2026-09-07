// Local preview controls. No requests to Janitor, GitHub, or an AI provider.
const scenario = document.querySelector("#scenario")
const dialog = document.querySelector("#detail-dialog")
const content = document.querySelector("#detail-content")
document.querySelector("#theme").addEventListener("click", () => {
  document.documentElement.classList.toggle("dark")
})
const states = {
  enabled: ["Enabled", "4 rules ready for repository updates.", "Last evaluation 12 minutes ago"],
  attention: [
    "Updates blocked",
    "Label-write permission is missing.",
    "Last evaluation 12 minutes ago",
  ],
  paused: [
    "Paused",
    "All rules are disabled. Existing labels stay in place.",
    "Last evaluation 12 minutes ago",
  ],
  empty: ["No rules yet", "Your repository is connected and ready.", "Not evaluated yet"],
}
scenario.addEventListener("change", () => {
  const state = scenario.value
  document.body.dataset.state = state
  const [title, copy, last] = states[state]
  document.querySelector("[data-status]").textContent = title
  document.querySelector("[data-status-copy]").textContent = copy
  document.querySelector("[data-last]").textContent = last
  document.querySelector("[data-rule-count]").innerHTML =
    state === "empty" ? "0" : state === "paused" ? "0<span> / 4</span>" : "4<span> / 4</span>"
  document.querySelector(".attention").hidden = state !== "attention"
  document.querySelector(".empty-state").hidden = state !== "empty"
  document.querySelectorAll("[data-populated]").forEach((el) => {
    el.hidden = state === "empty"
  })
  document.querySelectorAll(".rule-card .tiny-dot").forEach((el) => {
    el.title = state === "paused" ? "Rule disabled" : "Rule enabled"
  })
})
const details = {
  rules: [
    "Labeling rules",
    "Four example rules: two AI rules for the kind of change, and two policy rules for the Effect version.",
    "Open rule table mockup",
    "9e-rule-table-flow.html",
  ],
  rule: [
    "Rule configuration",
    "This card would open the selected rule. The linked study shows the AI prompt editor and test bench.",
    "Open AI rule mockup",
    "11e-ai-inline-facts.html",
  ],
  policies: [
    "Published policies",
    "Three reusable policies define the conditions used by these rules. Internally owned AI policies are excluded.",
    "Open policy mockup",
    "8a-policy-document.html",
  ],
  activity: [
    "All activity",
    "The application would open the full Activity screen here. These five entries are fixed examples, not production history.",
  ],
  settings: [
    "Repository settings",
    "The application would open repository settings here, including sync and AI access controls.",
  ],
  permissions: [
    "Allow label updates",
    "In GitHub App settings, grant Issues read and write access, then approve the updated permissions for the installation. This preview changes no permissions.",
  ],
  sync: [
    "Sync preview",
    "The repository is up to date in this example. The production sync button remains in the application header.",
  ],
  pr: [
    "Pull request preview",
    "This is an illustrative pull request. In the application, its title would open the corresponding pull request on GitHub.",
  ],
}
function showDetail(kind, number) {
  const [title, description, label, href] = details[kind]
  content.replaceChildren()
  const h = document.createElement("h2")
  h.textContent = title + (number ? ` #${number}` : "")
  const p = document.createElement("p")
  p.textContent = description
  content.append(h, p)
  if (href) {
    const a = document.createElement("a")
    a.className = "btn"
    a.href = href
    a.textContent = label
    content.append(a)
  }
  dialog.showModal()
}
document.querySelectorAll("[data-detail]").forEach((el) =>
  el.addEventListener("click", (event) => {
    event.preventDefault()
    showDetail(el.dataset.detail, el.dataset.number)
  }),
)
document.querySelector("#sync").addEventListener("click", () => showDetail("sync"))
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const r = dialog.getBoundingClientRect()
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      dialog.close()
  }
})
