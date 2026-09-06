/* Local-only interaction model. No API calls or GitHub mutations. */
;(() => {
  const $ = (selector) => document.querySelector(selector)
  const all = (selector) => [...document.querySelectorAll(selector)]
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    )
  const icon = (name) =>
    `<svg class="rs-icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`
  const policies = {
    docs: {
      name: "Touches documentation",
      description: "All changed files are within the docs directory.",
      version: 3,
      target: "Pull requests",
      fact: "Files are in docs/**",
    },
    main: {
      name: "Targets main",
      description: "The pull request targets the default branch.",
      version: 2,
      target: "Pull requests",
      fact: "Base branch is main",
    },
    bug: {
      name: "Fixes a bug",
      description: "The pull request describes a bug fix.",
      version: 1,
      target: "Pull requests",
      fact: "Title describes a fix",
    },
    first: {
      name: "First contribution",
      description: "The author is contributing to this repository for the first time.",
      version: 1,
      target: "Pull requests",
      fact: "First-time contributor",
    },
    stale: {
      name: "Inactive issue",
      description: "The issue has had no activity for more than 30 days.",
      version: 2,
      target: "Issues",
      fact: "Inactive for 30 days",
    },
  }
  const colors = {
    documentation: "#82a8d3",
    "needs-review": "#c3a174",
    bug: "#d18c89",
    "first-contribution": "#9aad8b",
    stale: "#aaa0bc",
  }
  const samples = {
    docs: {
      number: 8049,
      title: "Clarify the Stream guide",
      files: ["docs/guides/stream.md", "docs/examples/stream.ts"],
      labels: ["needs-review"],
      matches: ["docs", "main", "first"],
    },
    core: {
      number: 8051,
      title: "Fix a retry regression",
      files: ["packages/effect/src/Effect.ts", "packages/effect/test/Effect.test.ts"],
      labels: ["bug", "documentation"],
      matches: ["main", "bug"],
    },
    mixed: {
      number: 8047,
      title: "Update docs and runtime",
      files: ["docs/guides/runtime.md", "packages/effect/src/Runtime.ts"],
      labels: ["documentation"],
      matches: ["main"],
    },
  }
  const issueSamples = {
    docs: {
      number: 442,
      title: "Question about Stream cancellation",
      files: [],
      labels: ["needs-review"],
      matches: ["stale"],
    },
    core: {
      number: 448,
      title: "Report a retry regression",
      files: [],
      labels: ["bug"],
      matches: [],
    },
    mixed: {
      number: 451,
      title: "Improve the runtime guide",
      files: [],
      labels: ["documentation"],
      matches: [],
    },
  }
  const fields = ["label", "policy", "miss", "group", "priority", "enabled"]
  const seed = [
    {
      id: "docs",
      label: "documentation",
      policy: "docs",
      miss: "remove",
      group: "",
      priority: "20",
      enabled: true,
      revision: 4,
    },
    {
      id: "review",
      label: "needs-review",
      policy: "main",
      miss: "preserve",
      group: "",
      priority: "0",
      enabled: true,
      revision: 2,
    },
    {
      id: "bug",
      label: "bug",
      policy: "bug",
      miss: "remove",
      group: "change-type",
      priority: "10",
      enabled: true,
      revision: 1,
    },
    {
      id: "first",
      label: "first-contribution",
      policy: "first",
      miss: "preserve",
      group: "",
      priority: "0",
      enabled: true,
      revision: 1,
    },
    {
      id: "stale",
      label: "stale",
      policy: "stale",
      miss: "remove",
      group: "",
      priority: "0",
      enabled: false,
      revision: 3,
    },
  ]
  const rules = seed.map((rule) => ({ ...rule, saved: { ...rule } }))
  const flowView = document.body.dataset.variant === "e"
  const tableView = flowView || document.body.dataset.variant === "c"
  let current = tableView ? null : rules[0]
  let filter = "all"
  let nextId = 1
  let toastTimer
  const snapshot = (rule) => JSON.stringify(fields.map((field) => rule[field]))
  const dirty = (rule) => rule && (!rule.saved || snapshot(rule) !== snapshot(rule.saved))
  const issues = (rule) => [
    ...(!rule.label ? ["Choose a GitHub label."] : []),
    ...(!rule.policy ? ["Choose a published policy."] : []),
    ...(rule.priority.trim() && !/^-?\d+$/.test(rule.priority.trim())
      ? ["Priority must be a whole number."]
      : []),
  ]
  const text = (selector, value) =>
    all(selector).forEach((element) => {
      element.textContent = value
    })
  const toast = (message) => {
    const element = $(".rs-toast")
    element.textContent = message
    element.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      element.hidden = true
    }, 3200)
  }
  const behavior = (rule) => {
    const conditions = {
      docs: "only documentation files change",
      main: "a pull request targets main",
      bug: "a pull request describes a bug fix",
      first: "the author is a first-time contributor",
      stale: "an issue has been inactive for 30 days",
    }
    return rule.policy && rule.label
      ? `Add ${rule.label} when ${conditions[rule.policy]}. Otherwise, ${rule.miss === "remove" ? "remove the label" : "leave it unchanged"}.`
      : "Choose a label and a policy to define this rule."
  }
  function renderList() {
    const query = $("#search").value.trim().toLowerCase()
    const visible = rules.filter(
      (rule) =>
        `${rule.label} ${policies[rule.policy]?.name ?? "New rule"} ${behavior(rule)} policy`
          .toLowerCase()
          .includes(query) &&
        (filter === "all" || (filter === "enabled" ? rule.enabled : !rule.enabled)),
    )
    text("[data-rule-count]", rules.length)
    text(".rs-nav-count", rules.length)
    $("[data-filter-empty]").hidden = visible.length > 0 || rules.length === 0
    const table = tableView
    $("[data-rule-list]").innerHTML = visible
      .map((rule) => {
        const selected = current?.id === rule.id
        const label = escape(rule.label || "New rule")
        const policy = escape(policies[rule.policy]?.name || "Choose a policy")
        const status = !rule.saved ? "Unsaved" : !rule.enabled ? "Paused" : "Enabled"
        const color = colors[rule.label] || "#999"
        if (table) {
          const description = escape(behavior(rule))
          if (flowView)
            return `<tr><td><span class="rs-label-chip" style="--label-color:${color}">${label}${dirty(rule) ? " ·" : ""}</span></td><td><span class="rs-rule-type">${icon("file")}Policy</span></td><td><span class="rs-behavior" title="${description}">${description}</span><small>${policy}</small></td><td><span class="rs-status ${!rule.enabled ? "is-paused" : ""}">${status}</span></td><td><details class="rs-row-menu" data-row-menu="${rule.id}"><summary aria-label="Actions for ${label}" title="Rule actions">${icon("more")}</summary><div class="rs-menu-panel"><button type="button" data-select="${rule.id}">${icon("file")}Edit rule</button></div></details></td></tr>`
          return `<tr class="${selected ? "is-current" : ""}" data-select="${rule.id}" tabindex="0" aria-selected="${selected}" aria-controls="rule-sheet" aria-expanded="${selected}" aria-label="Configure ${label}"><td><span class="rs-label-chip" style="--label-color:${color}">${label}${dirty(rule) ? " ·" : ""}</span></td><td><span class="rs-rule-type">${icon("file")}Policy</span></td><td><span class="rs-behavior" title="${description}">${description}</span><small>${policy}</small></td><td><span class="rs-status ${!rule.enabled ? "is-paused" : ""}">${status}</span></td><td>${icon("chevron")}</td></tr>`
        }
        return `<button class="rs-rule-item" type="button" data-select="${rule.id}" ${selected ? 'aria-current="true"' : ""}><span class="rs-rule-item-top"><span class="rs-label-dot" style="--label-color:${color}"></span><span class="rs-label-name">${label}${dirty(rule) ? " ·" : ""}</span><span class="rs-state-dot ${!rule.enabled ? "is-paused" : ""}" title="${status}"></span></span><small>${policy}${!rule.enabled ? " · Paused" : ""}</small><span class="rs-sr-only">${status}${dirty(rule) ? ", unsaved changes" : ""}</span></button>`
      })
      .join("")
    if (!current) {
      $("[data-empty] h1").textContent = rules.length
        ? "Select a labeling rule"
        : "Create your first labeling rule"
      $("[data-empty] p").textContent = rules.length
        ? "Choose a rule to review its policy and label behavior."
        : "Connect a published policy to a GitHub label to get started."
    }
  }
  function renderFields() {
    all("[data-editor], [data-inspector]").forEach((element) => {
      element.hidden = !current
    })
    $("[data-empty]").hidden = !!current || (tableView && rules.length > 0)
    document.body.dataset.sheetOpen = String(!!current)
    if (flowView) {
      $(".rs-table-pane").hidden = !!current
      $(".rs-flow-page").hidden = !current
      text("[data-flow-mode]", current?.saved ? "Edit rule" : "Create rule")
    }
    if (!current) return
    all("[data-field]").forEach((element) => {
      const value = current[element.dataset.field]
      if (element.type === "radio") element.checked = element.value === value
      else if (element.type === "checkbox") element.checked = value
      else element.value = value
    })
    $(".rs-grouping").open = !!current.group
    renderState()
    renderSample()
  }
  function renderState() {
    if (!current) return
    const policy = policies[current.policy]
    const hasChanges = dirty(current)
    const errors = issues(current)
    text("[data-rule-title]", current.label || "New rule")
    all("[data-rule-title]").forEach((el) => {
      el.closest("header").style.setProperty("--label-color", colors[current.label] || "#999")
    })
    text(
      "[data-heading-description]",
      policy
        ? `Apply this label to ${policy.target.toLowerCase()} that match ${policy.name}.`
        : "Choose a label and a published policy.",
    )
    text(
      "[data-policy-description]",
      policy?.description || "Only published policies can be used by a rule.",
    )
    text("[data-policy-version]", policy ? `Published v${policy.version}` : "No policy selected")
    text("[data-policy-target]", policy?.target || "Select a policy")
    text("[data-sample-label]", policy?.target || "Pull requests")
    text("[data-live-label]", current.label || "Choose a label")
    text("[data-revision]", current.saved ? String(current.revision) : "Not saved")
    text(
      "[data-miss-help]",
      current.miss === "remove"
        ? "Remove this label if the policy stops matching."
        : "Keep the existing label state if the policy does not match.",
    )
    text("[data-group-summary]", current.group.trim() || "None")
    const peers = rules.filter(
      (r) => r.id !== current.id && r.group.trim() === current.group.trim(),
    )
    text(
      "[data-group-preview]",
      current.group.trim()
        ? peers.length
          ? `Other rules: ${peers.map((r) => `${r.label} · priority ${r.priority || "0"}`).join(", ")}`
          : "No other rules in this group."
        : "",
    )
    text(
      "[data-sentence]",
      `When ${policy?.name || "the selected policy"} matches, add ${current.label || "the selected label"}. Otherwise, ${current.miss === "remove" ? "remove it" : "leave it unchanged"}.`,
    )
    const status = $("[data-status]")
    if (status) {
      status.textContent = hasChanges ? "Unsaved" : current.enabled ? "Enabled" : "Paused"
      status.className = `rs-status ${hasChanges ? "is-dirty" : !current.enabled ? "is-paused" : ""}`
    }
    $("[data-save-actions]").hidden = !hasChanges
    $('[data-action="save"]').disabled = errors.length > 0
    $('[data-action="save"]').textContent = current.saved ? "Save changes" : "Create rule"
    const validation = $("[data-validation]")
    if (validation) {
      validation.classList.toggle("is-invalid", errors.length > 0)
      validation.innerHTML =
        icon(errors.length ? "close" : "check") +
        `<span>${escape(errors.length ? errors.join(" ") : "Valid rule")}</span>`
    }
    const fieldErrors = $("[data-field-errors]")
    if (fieldErrors) {
      fieldErrors.hidden = !errors.length
      fieldErrors.textContent = errors.join(" ")
    }
    all(".rc-delete").forEach((button) => {
      button.hidden = !current.saved
    })
    $('[data-action="test"]').disabled = errors.length > 0
    renderList()
  }
  function renderSample() {
    if (!current) return
    const data = current.policy === "stale" ? issueSamples : samples
    const select = $("#sample")
    for (const option of select.options)
      option.textContent = `#${data[option.value].number} · ${data[option.value].title}`
    const sample = data[select.value]
    text("[data-sample-title]", sample.title)
    text("[data-sample-number]", `#${sample.number}`)
    text(
      ".rs-sample-context>.rs-eyebrow",
      current.policy === "stale" ? "Selected issue" : "Selected pull request",
    )
    if ($("[data-sample-files]"))
      $("[data-sample-files]").innerHTML = sample.files.length
        ? sample.files.map((file) => `<div>${icon("file")}${escape(file)}</div>`).join("")
        : "<div>No changed files on an issue.</div>"
  }
  function clearTest() {
    const panel = $("[data-test-results]")
    panel.className = "rs-test-results is-stale"
    panel.textContent = "Run a test to preview these changes."
  }
  function testRule() {
    if (!current || issues(current).length) return clearTest()
    const policy = policies[current.policy]
    const sample = (current.policy === "stale" ? issueSamples : samples)[$("#sample").value]
    const match = sample.matches.includes(current.policy)
    const winner = current.group.trim()
      ? rules
          .filter(
            (r) =>
              r.id !== current.id &&
              r.enabled &&
              r.group.trim() === current.group.trim() &&
              sample.matches.includes(r.policy) &&
              Number(r.priority || 0) < Number(current.priority || 0),
          )
          .sort((a, b) => Number(a.priority) - Number(b.priority))[0]
      : undefined
    const title = !current.enabled
      ? "Rule is paused"
      : winner
        ? "Another rule takes priority"
        : match
          ? "Policy matches"
          : "Policy does not match"
    const action = !current.enabled ? "none" : winner ? "remove" : match ? "add" : current.miss
    const present = sample.labels.includes(current.label)
    const changes = action === "add" ? !present : action === "remove" ? present : false
    const outcome = changes
      ? action === "add"
        ? "Label will be added"
        : "Label will be removed"
      : "No label changes"
    const detail = winner
      ? `${winner.label} wins · priority ${winner.priority}`
      : !current.enabled
        ? "Enable the rule to apply its result"
        : changes
          ? action === "add"
            ? "Add label"
            : "Remove label"
          : action === "add"
            ? "Already present"
            : action === "remove"
              ? "Already absent"
              : "Leave unchanged"
    const panel = $("[data-test-results]")
    panel.className = `rs-test-results ${!match || !current.enabled || winner ? "is-no-match" : ""}`
    panel.innerHTML = `<div class="rs-result-heading"><span class="rs-result-icon">${icon(match && current.enabled && !winner ? "check" : "close")}</span><div><strong>${escape(title)}</strong><span>${escape(outcome)}</span></div></div><div class="rs-trace"><div>${icon("check")}<span>${escape(policy.target === "Issues" ? "Issue" : "Pull request")}</span><span class="rs-small">Match</span></div><div>${icon(match ? "check" : "close")}<span>${escape(policy.fact)}</span><span class="rs-small">${match ? "Match" : "No match"}</span></div></div><div class="rs-label-change"><span class="rs-change-sign">${changes ? (action === "add" ? "+" : "−") : "·"}</span><span class="rs-label-chip" style="--label-color:${colors[current.label] || "#999"}">${escape(current.label)}</span><span class="rs-small">${escape(detail)}</span></div>`
  }
  all("[data-field]").forEach((element) =>
    element.addEventListener(
      element.tagName === "INPUT" && !["radio", "checkbox"].includes(element.type)
        ? "input"
        : "change",
      () => {
        if (!current) return
        current[element.dataset.field] =
          element.type === "checkbox" ? element.checked : element.value
        renderState()
        if (element.dataset.field === "policy") renderSample()
        clearTest()
      },
    ),
  )
  $("#search").addEventListener("input", renderList)
  $("#sample").addEventListener("change", () => {
    renderSample()
    clearTest()
  })
  function returnToTable() {
    const previousId = current?.id
    current = null
    renderFields()
    renderList()
    const target = $(`[data-row-menu="${previousId}"] summary`) || $('[data-action="new"]')
    target.focus()
  }
  document.addEventListener("click", (event) => {
    all(".rs-row-menu[open]").forEach((menu) => {
      if (!menu.contains(event.target)) menu.open = false
    })
    const selected = event.target.closest("[data-select]")
    if (selected) {
      current = rules.find((rule) => rule.id === selected.dataset.select)
      renderList()
      renderFields()
      testRule()
      $("#rule-sheet-title, #rule-flow-title")?.focus()
      return
    }
    const filterButton = event.target.closest("[data-filter]")
    if (filterButton) {
      filter = filterButton.dataset.filter
      all("[data-filter]").forEach((el) => {
        el.classList.toggle("is-current", el === filterButton)
        el.setAttribute("aria-pressed", String(el === filterButton))
      })
      renderList()
      return
    }
    const action = event.target.closest("[data-action]")?.dataset.action
    if (action === "theme") document.documentElement.classList.toggle("dark")
    if (action === "test") testRule()
    if (action === "new") {
      current = {
        id: `new-${nextId++}`,
        label: "",
        policy: "",
        miss: "remove",
        group: "",
        priority: "0",
        enabled: true,
        revision: 0,
        saved: null,
      }
      rules.unshift(current)
      $("#search").value = ""
      filter = "all"
      all("[data-filter]").forEach((el) => {
        el.classList.toggle("is-current", el.dataset.filter === "all")
        el.setAttribute("aria-pressed", String(el.dataset.filter === "all"))
      })
      renderList()
      renderFields()
      clearTest()
      $(flowView ? "#policy" : "#label").focus()
    }
    if (action === "save" && current && !issues(current).length) {
      current.revision += 1
      current.saved = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "saved"))
      renderState()
      toast("Rule saved in this mockup.")
      if (flowView) returnToTable()
    }
    if (action === "cancel-flow" && current) {
      if (current.saved) Object.assign(current, current.saved)
      else rules.splice(rules.indexOf(current), 1)
      returnToTable()
    }
    if (action === "discard" && current) {
      if (current.saved) Object.assign(current, current.saved)
      else {
        rules.splice(rules.indexOf(current), 1)
        current = rules[0] || null
      }
      renderList()
      renderFields()
      if (current) testRule()
    }
    if (action === "close") {
      all(".rs-menu[open]").forEach((menu) => {
        menu.open = false
      })
      const previousId = current?.id
      current = null
      renderFields()
      renderList()
      if (previousId)
        $(
          flowView ? `[data-row-menu="${previousId}"] summary` : `[data-select="${previousId}"]`,
        )?.focus()
    }
    if (action === "delete" && current) {
      all(".rs-menu[open]").forEach((menu) => {
        menu.open = false
      })
      $(".rs-delete-dialog").showModal()
    }
    if (action === "cancel-delete") $(".rs-delete-dialog").close()
    if (action === "confirm-delete" && current) {
      rules.splice(rules.indexOf(current), 1)
      current = null
      $(".rs-delete-dialog").close()
      renderFields()
      renderList()
      toast("Rule removed from this mockup.")
    }
    if (!event.target.closest(".rs-menu, .rs-row-menu"))
      all(".rs-menu[open], .rs-row-menu[open]").forEach((menu) => {
        menu.open = false
      })
  })
  document.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("tr[data-select]")) {
      event.preventDefault()
      event.target.click()
    }
    if (
      event.key === "/" &&
      $("#search").checkVisibility() &&
      !event.target.closest("input,select,textarea,dialog")
    ) {
      event.preventDefault()
      $("#search").focus()
    }
    if (event.key === "Escape")
      all(".rs-menu[open], .rs-row-menu[open]").forEach((menu) => {
        menu.open = false
      })
  })
  renderList()
  renderFields()
  testRule()
})()
