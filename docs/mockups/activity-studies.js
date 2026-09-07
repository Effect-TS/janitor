/* Local, fictional activity. These studies never call Janitor or GitHub APIs. */
const paths = {
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
  policy: '<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>',
  rule: '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="8" cy="5" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="19" r="2"/>',
  settings:
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m12 3 10 18H2Z M12 9v5m0 3v1"/>',
  minus: '<path d="M5 12h14"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  theme: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>',
  pr: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10m12 0v-6a6 6 0 0 0-6-6m0 0 3-3m-3 3 3 3"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
  broom: '<path d="m17 2-6 11m-4-2 9 5-5 6-9-5Z M6 14l-2 4m5-2-2 4"/>',
}
const icon = (name, className = "") =>
  `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.activity}</svg>`
const events = [
  {
    id: 1,
    number: 7908,
    title: "Fix interruption handling in scoped effects",
    kind: "Pull request",
    time: "09:42",
    state: "applied",
    label: "bug",
    action: "Added",
    rule: "Bug fixes",
    type: "AI",
    trigger: "Description edited",
    reason:
      "The description identifies an interruption bug and explains how the change restores the expected behavior.",
    input: "Complete",
    confidence: "94%",
    duration: "3.2 s",
  },
  {
    id: 2,
    number: 7991,
    title: "Clarify the behavior of Effect.all",
    kind: "Pull request",
    time: "09:40",
    state: "failed",
    label: "documentation",
    action: "Could not add",
    rule: "Documentation changes",
    type: "Policy",
    trigger: "Pull request opened",
    reason:
      "The rule matched, but GitHub rejected the label update because the app lacks write access to pull requests.",
    duration: "0.8 s",
  },
  {
    id: 3,
    number: 7990,
    title: "Unexpected behavior with nested scopes",
    kind: "Issue",
    time: "09:37",
    state: "uncertain",
    label: "bug",
    action: "Left unchanged",
    rule: "Bug fixes",
    type: "AI",
    trigger: "Issue opened",
    reason:
      "The supplied report describes unexpected behavior but does not establish a defect. Confidence fell below the rule’s 80% minimum.",
    input: "Shortened",
    confidence: "61%",
    duration: "4.1 s",
  },
  {
    id: 4,
    number: 7988,
    title: "Refactor internal runtime helpers",
    kind: "Pull request",
    time: "09:32",
    state: "unchanged",
    label: "bug",
    action: "Left unchanged",
    rule: "Bug fixes",
    type: "AI",
    trigger: "Pull request opened",
    reason:
      "The description presents an internal refactor without a change in observable behavior. The bug rule did not match.",
    input: "Complete",
    confidence: "92%",
    duration: "2.7 s",
  },
  {
    id: 5,
    number: 7985,
    title: "Update Stream examples and implementation",
    kind: "Pull request",
    time: "09:28",
    state: "applied",
    label: "documentation",
    action: "Removed",
    rule: "Documentation changes",
    type: "Policy",
    trigger: "New commits pushed",
    reason:
      "The latest commits also change source files. This pull request no longer meets the documentation-only policy.",
    duration: "0.3 s",
  },
  {
    id: 6,
    number: 7982,
    title: "Add a concurrency option to Stream.merge",
    kind: "Pull request",
    time: "09:15",
    state: "applied",
    label: "feature",
    action: "Added",
    rule: "New capabilities",
    type: "AI",
    trigger: "Pull request opened",
    reason: "The description introduces a new public option for controlling concurrency.",
    input: "Complete",
    confidence: "96%",
    duration: "2.9 s",
  },
  {
    id: 7,
    number: 7908,
    title: "Fix interruption handling in scoped effects",
    kind: "Pull request",
    time: "08:56",
    state: "uncertain",
    label: "bug",
    action: "Left unchanged",
    rule: "Bug fixes",
    type: "AI",
    trigger: "Pull request opened",
    reason:
      "The original description did not explain which behavior was incorrect. Labels were preserved until enough evidence was available.",
    input: "Complete",
    confidence: "65%",
    duration: "3.0 s",
  },
  {
    id: 8,
    number: 7985,
    title: "Update Stream examples and implementation",
    kind: "Pull request",
    time: "08:41",
    state: "applied",
    label: "documentation",
    action: "Added",
    rule: "Documentation changes",
    type: "Policy",
    trigger: "Pull request opened",
    reason: "All changed files were in the documentation directory at the time of this evaluation.",
    duration: "0.2 s",
  },
]
const variants = [
  ["a", "13a-activity-journal.html", "Journal"],
  ["b", "13b-activity-ledger.html", "Table + detail"],
  ["c", "13c-activity-threads.html", "By pull request"],
  ["d", "13d-activity-attention.html", "Attention first"],
]
const variant = document.body.dataset.variant
const descriptions = {
  a: "A readable history of what changed and why.",
  b: "Every labeling decision, with the details one click away.",
  c: "Follow the labeling history of an issue or pull request.",
  d: "Decisions that need a closer look, with routine activity out of the way.",
}
let selected = 1
let filter = "all"
let queue = "attention"
const stateNames = {
  applied: "Applied",
  failed: "Failed",
  uncertain: "Insufficient evidence",
  unchanged: "No change",
}
const stateIcon = (state) =>
  state === "applied" ? "check" : state === "unchanged" ? "minus" : "alert"
const badge = (event) => `<span class="tag ${event.label}">${event.label}</span>`
const status = (event) =>
  `<span class="status ${event.state}">${icon(stateIcon(event.state))}${stateNames[event.state]}</span>`
const github = (event) =>
  `https://github.com/Effect-TS/effect/${event.kind === "Issue" ? "issues" : "pull"}/${event.number}`
const links = (event) =>
  `<div class="detail-links"><a href="${event.type === "AI" ? "11e-ai-inline-facts.html" : "9e-rule-table-flow.html"}">View rule ${icon("arrow")}</a><a href="${github(event)}" target="_blank" rel="noopener">Open on GitHub ${icon("external")}</a></div>`
function detail(event) {
  return `<div class="detail-section"><h2>Decision</h2><p class="detail-copy">${event.reason}</p><div class="decision-row"><span>${event.rule}<small>${event.type} rule</small></span><span>${event.action}<br>${badge(event)}</span></div>${event.confidence ? `<div class="decision-row"><span>Confidence<small>Minimum 80%</small></span><span>${event.confidence}</span></div>` : ""}</div>
  ${event.input === "Shortened" ? '<div class="detail-section"><div class="notice"><strong>AI input was shortened</strong>2,184 characters from the middle of the issue description were omitted. The title was kept in full.</div><details style="margin-top:12px;font-size:11px"><summary>Inspect omitted content</summary><p class="detail-copy">Sample omitted content: repeated stack traces from three subsequent retries. In the application, this would show the exact saved excerpt.</p></details></div>' : ""}
  <div class="detail-section"><h2>This evaluation</h2><dl><dt>Triggered by</dt><dd>${event.trigger}</dd><dt>Evaluated at</dt><dd>${event.time}:12</dd><dt>Duration</dt><dd>${event.duration}</dd>${event.input ? `<dt>AI input</dt><dd>${event.input}</dd>` : ""}<dt>GitHub labels</dt><dd>${event.state === "applied" ? "Updated" : "Unchanged"}</dd></dl>${links(event)}</div>`
}
function journal(items) {
  if (!items.length) return ""
  return `<div class="time-heading"><strong>Today <span class="muted">· September 7</span></strong><span>All times EDT</span></div>${items.map((event) => `<details class="event"><summary><span class="event-icon ${event.state}">${icon(stateIcon(event.state))}</span><div><h3>${event.action} ${badge(event)} <span class="muted">on #${event.number}</span></h3><div class="subline">${event.title}</div><div class="subline">${event.rule}<span>·</span>${event.type} rule${event.state === "uncertain" ? '<span>·</span><span class="status uncertain">Insufficient evidence</span>' : ""}</div></div><time>${event.time}</time>${icon("arrow", "chevron")}</summary><div class="event-detail">${detail(event)}</div></details>`).join("")}`
}
function ledger(items) {
  const event = items.find((item) => item.id === selected) || items[0]
  selected = event.id
  return `<div class="ledger-layout"><div class="table-scroll"><table class="activity-table"><thead><tr><th>Subject</th><th>Label change</th><th>Result</th><th>Time</th></tr></thead><tbody>${items.map((item) => `<tr class="${item.id === selected ? "selected" : ""}"><td><button class="subject-button" data-select="${item.id}" aria-pressed="${item.id === selected}">${item.title}</button><div class="subline">#${item.number} <span>·</span> ${item.type}</div></td><td><div style="font-size:10px;margin-bottom:4px" class="muted">${item.action}</div>${badge(item)}</td><td>${status(item)}</td><td class="muted" style="font-size:11px;white-space:nowrap">${item.time}</td></tr>`).join("")}</tbody></table></div><aside class="inspector" aria-label="Selected activity"><div class="eyebrow"><span>ACTIVITY DETAILS</span><span>${items.findIndex((item) => item.id === selected) + 1} / ${items.length}</span></div>${status(event)}<h3>${event.title}</h3><a class="inline-link" href="${github(event)}" target="_blank" rel="noopener">${event.kind} #${event.number} ${icon("external")}</a>${detail(event)}</aside></div>`
}
function threads(items) {
  const groups = [...new Set(items.map((event) => event.number))]
  return `<div class="time-heading"><strong>${groups.length} subjects with activity today</strong><span>Most recently updated first</span></div>${groups
    .map((number, index) => {
      const history = items.filter((event) => event.number === number),
        latest = history[0]
      return `<details class="group-card" ${index === 0 ? "open" : ""}><summary>${icon("pr")}<div class="subject"><h3>${latest.title}</h3><div class="subline">${latest.kind} #${number} <span>·</span> ${history.length} ${history.length === 1 ? "evaluation" : "evaluations"} <span>·</span> Last update ${latest.time}</div></div>${latest.state === "applied" ? `<span class="status applied">${latest.action} ${badge(latest)}</span>` : status(latest)}${icon("arrow", "chevron")}</summary><div class="history">${history.map((event) => `<div class="history-entry"><time>${event.time}</time><div><h3>${event.action} ${badge(event)}</h3><p>${event.reason}</p><div class="subline">${event.trigger}<span>·</span>${event.rule}</div><details><summary>Evaluation details</summary>${detail(event)}</details></div></div>`).join("")}</div></details>`
    })
    .join("")}`
}
function attention(items) {
  // Only the latest decision for each rule and subject determines attention.
  const latest = items.filter(
    (event) =>
      events.find((item) => item.number === event.number && item.rule === event.rule)?.id ===
      event.id,
  )
  const attentionItems = latest.filter((event) => ["failed", "uncertain"].includes(event.state))
  const routine = latest.filter((event) => !["failed", "uncertain"].includes(event.state))
  const showing = queue === "attention" ? attentionItems : routine
  return `<div class="attention-layout"><nav class="queue-nav" aria-label="Activity queues"><button data-queue="attention" aria-pressed="${queue === "attention"}"><span>Needs attention</span><span>${attentionItems.length}</span></button><button data-queue="routine" aria-pressed="${queue === "routine"}"><span>Handled</span><span>${routine.length}</span></button><small>Based on the latest decision for each rule and subject. Earlier decisions remain in its history.</small></nav><section aria-label="${queue === "attention" ? "Needs attention" : "Handled activity"}">${showing.length ? showing.map((event) => `<article class="attention-card">${status(event)}<h3>${event.title}</h3><div class="subline">${event.kind} #${event.number}<span>·</span>${event.time}<span>·</span>${badge(event)}</div><p class="detail-copy">${event.reason}</p>${event.input === "Shortened" ? '<div class="notice"><strong>Partial input</strong>The issue description was shortened before evaluation.</div>' : ""}<div class="resolution"><span>${event.state === "failed" ? "Check GitHub App permissions." : event.state === "uncertain" ? "Review the evidence before changing this rule." : "Labeling completed. No action needed."}</span><a class="inline-link" href="${event.state === "failed" ? "https://github.com/settings/installations" : "11e-ai-inline-facts.html"}" ${event.state === "failed" ? 'target="_blank" rel="noopener"' : ""}>${event.state === "failed" ? "GitHub settings" : "View rule"} ${icon("external")}</a></div><details><summary>Decision and history</summary>${detail(event)}${journal(events.filter((item) => item.number === event.number && item.id !== event.id))}</details></article>`).join("") : `<div class="empty">${icon("check")}<h2>Nothing needs attention</h2><p>No ${queue === "attention" ? "unresolved decisions" : "completed activity"} in this view.</p></div>`}</section></div>`
}
document.body.classList.add(`variant-${variant}`)
document.getElementById("app").innerHTML = `
  <div class="study-bar"><strong>Activity studies</strong><nav aria-label="Design variants">${variants.map(([key, file, name]) => `<a href="${file}" ${key === variant ? 'aria-current="page"' : ""}>${key.toUpperCase()} · ${name}</a>`).join("")}</nav><span class="sample">Interactive mockup · sample data</span><button class="icon-btn" id="theme" aria-label="Switch color theme">${icon("theme")}</button></div>
  <div class="frame"><aside class="rail"><div class="brand"><span class="brand-mark">${icon("broom")}</span><div><b>The Janitor</b><small>Repository maintenance</small></div></div><div class="repo"><span class="avatar">EF</span><span><small>Effect-TS</small><b>effect</b></span>${icon("arrow")}</div><nav aria-label="Repository navigation">${[
    ["home", "Overview", "12e-overview-empty.html"],
    ["policy", "Policies", "8a-policy-document.html"],
    ["rule", "Rules", "9e-rule-table-flow.html"],
    ["activity", "Activity", variants.find(([key]) => key === variant)[1]],
  ]
    .map(
      ([symbol, label, url]) =>
        `<a href="${url}" ${label === "Activity" ? 'aria-current="page"' : ""}>${icon(symbol)}${label}</a>`,
    )
    .join(
      "",
    )}</nav><div class="rail-foot"><span class="dot"></span>Automation enabled</div></aside><div class="workspace"><header class="topbar"><span class="muted" style="margin:0">effect</span><span class="muted" style="margin:0">/</span><span>Activity</span><span class="muted">Updated just now</span></header><main><div class="heading"><div><h1>Activity</h1><p>${descriptions[variant]}</p></div><select id="period" aria-label="Time period"><option value="today">Today</option><option value="hour">Since 09:30</option><option value="empty">Yesterday</option></select></div><div class="toolbar"><label class="search">${icon("search")}<input id="search" type="search" placeholder="Find a PR, label, or rule…" aria-label="Search activity"></label>${
    variant !== "d"
      ? `<div class="tabs" role="group" aria-label="Activity outcome">${[
          ["all", "All activity"],
          ["applied", "Changes"],
          ["attention", "Needs attention"],
        ]
          .map(
            ([value, label]) =>
              `<button data-filter="${value}" aria-pressed="${filter === value}">${label}</button>`,
          )
          .join("")}</div>`
      : ""
  }<select id="target" aria-label="Subject type"><option value="all">All subjects</option><option>Pull request</option><option>Issue</option></select><span class="count" id="count" aria-live="polite"></span></div><div id="content"></div><p class="footnote">Illustrative events and explanations. Rule links open the editor studies; GitHub links open the real site. No actions are performed.</p></main></div></div>`
function render() {
  const query = document.getElementById("search").value.toLowerCase().trim()
  const target = document.getElementById("target").value
  const period = document.getElementById("period").value
  const items = events.filter(
    (event) =>
      (!query ||
        `${event.number} ${event.title} ${event.label} ${event.rule} ${event.reason}`
          .toLowerCase()
          .includes(query)) &&
      (target === "all" || event.kind === target) &&
      (period === "today" || (period === "hour" && event.time >= "09:30")) &&
      (filter === "all" ||
        filter === event.state ||
        (filter === "attention" && ["failed", "uncertain"].includes(event.state))),
  )
  document.getElementById("count").textContent =
    `${items.length} ${items.length === 1 ? "evaluation" : "evaluations"}`
  document.getElementById("content").innerHTML = items.length
    ? { a: journal, b: ledger, c: threads, d: attention }[variant](items)
    : `<div class="empty">${icon("activity")}<h2>${query ? "No matching activity" : "No activity in this period"}</h2><p>${query ? "Try another PR number, label, or rule." : "Janitor’s decisions will appear here when it evaluates an issue or pull request."}</p><button data-reset>Reset filters</button></div>`
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button")
  if (!button) return
  if (button.id === "theme") {
    document.documentElement.classList.toggle("dark")
    return
  }
  if (button.dataset.filter) {
    filter = button.dataset.filter
    document
      .querySelectorAll("[data-filter]")
      .forEach((tab) => tab.setAttribute("aria-pressed", String(tab.dataset.filter === filter)))
    render()
  }
  if (button.dataset.select) {
    selected = Number(button.dataset.select)
    render()
    document.querySelector(`[data-select="${selected}"]`)?.focus({ preventScroll: true })
  }
  if (button.dataset.queue) {
    queue = button.dataset.queue
    render()
    document.querySelector(`[data-queue="${queue}"]`)?.focus({ preventScroll: true })
  }
  if (button.hasAttribute("data-reset")) {
    document.getElementById("search").value = ""
    document.getElementById("target").value = "all"
    document.getElementById("period").value = "today"
    filter = "all"
    document
      .querySelectorAll("[data-filter]")
      .forEach((tab) => tab.setAttribute("aria-pressed", String(tab.dataset.filter === "all")))
    render()
  }
})
document.getElementById("search").addEventListener("input", render)
document.getElementById("target").addEventListener("change", render)
document.getElementById("period").addEventListener("change", render)
render()
