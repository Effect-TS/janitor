// Standalone prototype. No backend calls, policy evaluation, or persistent writes.
const $ = (selector) => document.querySelector(selector)
const escapeHtml = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
const condition = (fact, value) => ({ fact, operator: "equals", value })
/** @type {Array<[string, string, object, string]>} */
const fixtures = [
  ["ready-for-review", "Open pull requests ready for a reviewer.", condition("draft", false), "v3"],
  [
    "needs-rebase",
    "Find open pull requests with merge conflicts.",
    condition("mergeable", "conflicting"),
    "v2",
  ],
  [
    "touches-schema",
    "Pull requests that change the schema package.",
    {
      some: "files",
      where: { fact: "path", operator: "matchesGlob", value: "packages/schema/**" },
    },
    "v1",
  ],
  [
    "is-bug-report",
    "Issues with a bug report in the title.",
    { fact: "title", operator: "contains", value: "bug" },
    "v4",
  ],
  [
    "stale-changes-requested",
    "Pull requests with changes still requested.",
    condition("reviewDecision", "changes_requested"),
    "v1",
  ],
  [
    "from-core-team",
    "Pull requests opened by a core maintainer.",
    condition("author", "maxwellbrown"),
    "Draft",
  ],
]
const policies = fixtures.map(([name, description, matchesWhen, version]) => ({
  name,
  description,
  version,
  source: JSON.stringify(
    {
      target: name === "is-bug-report" ? "issue" : "pull_request",
      appliesWhen: condition("state", "open"),
      matchesWhen,
    },
    null,
    2,
  ),
  dirty: false,
  draft: name === "needs-rebase" || version === "Draft",
}))
let selected = 1
const source = $("#source")
const initialRebaseSource = policies[1].source
let toastTimer
function notify(message) {
  $("#toast").textContent = message
  $("#toast").hidden = false
  clearTimeout(toastTimer)
  // Browser-only mockup; no Foldkit runtime is mounted here.
  // oxlint-disable-next-line effecttsgo(global-timers)
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true
  }, 3500)
}
function renderRows() {
  const query = $("#policy-search").value.trim().toLowerCase()
  $("#policy-rows").innerHTML = policies
    .map(
      (policy, i) =>
        `<button class="policy-row" data-index="${i}" ${i === selected ? 'aria-current="true"' : ""} ${policy.name.toLowerCase().includes(query) ? "" : "hidden"}><strong>${escapeHtml(policy.name || "Untitled policy")}</strong><small>${policy.name === "is-bug-report" ? "Issues" : "Pull requests"} · ${escapeHtml(policy.version)}${policy.draft && policy.version !== "Draft" ? ' <span class="row-draft">· Draft</span>' : ""}</small></button>`,
    )
    .join("")
  $("#policy-count").textContent = policies.length
  $("#empty-policies").hidden = policies.some((p) => p.name.toLowerCase().includes(query))
}
function renderSource() {
  const text = source.value
  $("#highlight").innerHTML =
    text.replace(
      /"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null|\d+)\b|[\s\S]/g,
      (token) => {
        const kind = token.startsWith('"')
          ? token.endsWith(":")
            ? "key"
            : "string"
          : /^(true|false|null|\d+)$/.test(token)
            ? "literal"
            : ""
        return kind ? `<span class="${kind}">${escapeHtml(token)}</span>` : escapeHtml(token)
      },
    ) + "\n"
  $("#line-numbers").textContent = text
    .split("\n")
    .map((_, i) => i + 1)
    .join("\n")
  let valid = true
  try {
    JSON.parse(text)
  } catch {
    valid = false
  }
  $("#validation").textContent = valid ? "✓ Valid JSON" : "Invalid JSON"
  $("#validation").classList.toggle("invalid", !valid)
  $("#save").disabled = $("#publish").disabled = !valid || !$("#policy-name").value.trim()
  syncScroll()
}
function syncScroll() {
  $("#highlight").scrollTop = source.scrollTop
  $("#highlight").scrollLeft = source.scrollLeft
  $("#line-numbers").scrollTop = source.scrollTop
}
function updateStatus() {
  const policy = policies[selected]
  $("#save-state").textContent = policy.dirty
    ? "Unsaved changes"
    : policy.draft
      ? "Draft saved"
      : "Published"
  document.querySelectorAll(".draft-state").forEach((el) => {
    el.textContent = policy.draft ? "Draft changes" : "Published"
  })
  document.querySelectorAll("[data-policy-title]").forEach((el) => {
    el.textContent = policy.name || "Untitled policy"
  })
}
function clearResults() {
  $("#test-results").innerHTML = '<p class="result-copy">Test this draft to preview a result.</p>'
}
function selectPolicy(index) {
  selected = index
  const p = policies[index]
  $("#policy-name").value = p.name
  $("#policy-description").value = p.description
  source.value = p.source
  const target = p.name === "is-bug-report" ? "Issues" : "Pull requests"
  const eyeline = $(".eyeline")
  if (eyeline)
    eyeline.innerHTML = `${target} <span>${p.version === "Draft" ? "Not published" : `Published ${p.version}`}</span>`
  const compactDetail = $(".metadata-disclosure summary span")
  if (compactDetail) compactDetail.textContent = `${target} · ${p.version}`
  const pairs = document.querySelectorAll(".inspector-details .detail-pair span:last-child")
  if (pairs.length) {
    pairs[0].textContent = target
    pairs[1].textContent = p.version
  }
  // The bench fixtures and rule dependencies belong only to the initial needs-rebase policy.
  $(".bench").hidden = index !== 1
  document.querySelectorAll(".inspector-section").forEach((el) => {
    el.hidden = index !== 1
  })
  const usedBy = $(".heading-tail .muted")
  if (usedBy) usedBy.textContent = index === 1 ? "Used by 1 rule" : "Sample policy"
  $(".bench-footnote").textContent =
    index === 1
      ? "Sample data. Tests and publishing are simulated; edits last until reload."
      : "No test fixtures for this sample policy. Select needs-rebase to explore the bench."
  clearResults()
  renderRows()
  renderSource()
  updateStatus()
}
function edit() {
  const p = policies[selected]
  p.name = $("#policy-name").value
  p.description = $("#policy-description").value
  p.source = source.value
  p.dirty = true
  p.draft = true
  updateStatus()
  renderRows()
  renderSource()
  clearResults()
}
$("#policy-rows").addEventListener("click", (event) => {
  const row = event.target.closest("[data-index]")
  if (row) selectPolicy(Number(row.dataset.index))
})
$("#policy-search").addEventListener("input", renderRows)
source.addEventListener("input", edit)
source.addEventListener("scroll", syncScroll)
$("#policy-name").addEventListener("input", edit)
$("#policy-description").addEventListener("input", edit)
$("#format").addEventListener("click", () => {
  try {
    source.value = JSON.stringify(JSON.parse(source.value), null, 2)
    edit()
    notify("JSON formatted")
  } catch {
    notify("Fix the JSON syntax before formatting.")
  }
})
$("#save").addEventListener("click", () => {
  policies[selected].dirty = false
  updateStatus()
  notify("Draft saved for this preview session.")
})
$("#publish").addEventListener("click", () => {
  const p = policies[selected]
  p.dirty = false
  p.draft = false
  p.version = `v${(Number(p.version.slice(1)) || 0) + 1}`
  selectPolicy(selected)
  notify(`Preview published as ${p.version}. No repository changes were made.`)
})
$("#new-policy").addEventListener("click", () => {
  policies.push({
    name: "untitled-policy",
    description: "",
    version: "Draft",
    draft: true,
    dirty: true,
    source: JSON.stringify(
      {
        target: "pull_request",
        appliesWhen: condition("state", "open"),
        matchesWhen: condition("draft", false),
      },
      null,
      2,
    ),
  })
  $("#policy-search").value = ""
  selectPolicy(policies.length - 1)
  const disclosure = $(".metadata-disclosure")
  if (disclosure) disclosure.open = true
  $("#policy-name").focus()
  $("#policy-name").select()
})
$("#sample").addEventListener("change", clearResults)
$("#run-test").addEventListener("click", () => {
  if (source.value !== initialRebaseSource) {
    $("#test-results").innerHTML =
      '<p class="result-copy">The program has changed. This mockup only includes results for the original needs-rebase program.</p>'
    return
  }
  const sample = $("#sample").value
  const title = sample === "match" ? "Match" : sample === "miss" ? "No match" : "Unknown"
  const copy =
    sample === "match"
      ? "This pull request meets every condition."
      : sample === "miss"
        ? "This pull request has no merge conflicts."
        : "Mergeability is still being checked. No decision yet."
  $("#test-results").innerHTML =
    `<div class="result-heading"><span class="result-tag">${title}</span><span class="muted">Sample result</span></div><p class="result-copy">${copy}</p><div class="trace"><div><span>State is open</span><b>✓</b></div><div><span>Merge conflicts found</span><b>${sample === "match" ? "✓" : sample === "miss" ? "No" : "Pending"}</b></div></div>${sample === "match" ? '<div class="test-effect"><span class="muted">Through rule <b>needs-rebase</b></span><span class="label-preview"><i></i>needs-rebase</span></div>' : ""}`
})
$("[data-theme-toggle]").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark")
  $("[data-theme-toggle]").setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`)
})
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
  ) {
    event.preventDefault()
    $("#policy-search").focus()
  }
})
selectPolicy(1)
$("#run-test").click()
