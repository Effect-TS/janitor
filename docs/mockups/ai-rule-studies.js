/* Local interaction fixtures only. No AI calls or GitHub mutations. */
const form = document.querySelector("#rule-form")
const get = (id) => document.getElementById(id)
const snapshot = () => JSON.stringify([...new FormData(form)])
let saved = snapshot()
let timer
const toast = (message) => {
  get("toast").textContent = message
  get("toast").hidden = false
  clearTimeout(timer)
  timer = setTimeout(() => {
    get("toast").hidden = true
  }, 3000)
}
const refresh = () => {
  get("actions").hidden = snapshot() === saved
  document.querySelectorAll("[data-label]").forEach((el) => {
    el.textContent = get("label").value
  })
  get("count").textContent = `${get("prompt").value.length} / 4,000`
  get("confidence-value").textContent = `${get("confidence").value}%`
  get("sample-label").textContent = get("target").value === "Issues" ? "Issues" : "Pull Requests"
  get("prompt").setCustomValidity(get("prompt").value.trim() ? "" : "Enter a yes/no question.")
  const evidence = [...form.querySelectorAll(".evidence input")]
  evidence[0]?.setCustomValidity(
    evidence.some((el) => el.checked && !el.disabled)
      ? ""
      : "Select at least one source of evidence.",
  )
}
const invalidate = () => {
  get("result").replaceChildren(
    Object.assign(document.createElement("p"), {
      textContent: "Run a test to preview this configuration.",
    }),
  )
  delete get("result").dataset.state
}
const targetChanged = () => {
  const issues = get("target").value === "Issues"
  const files = form.querySelector("[name=files]")
  if (files) {
    files.disabled = issues
    files.closest("label").hidden = issues
  }
  const titles = issues
    ? [
        "#912 Removed API breaks my upgrade",
        "#908 Typo in the tutorial",
        "#901 Scheduler behaves differently",
      ]
    : [
        "#1842 Remove deprecated constructors",
        "#1839 Clarify getting started guide",
        "#1827 Adjust scheduler behavior",
      ]
  Array.from(get("sample").options).forEach((option, i) => {
    option.textContent = titles[i]
  })
  showSample()
}
const fixtures = {
  match: [
    "Removes Stream.fromEffectOption and the legacy constructor overloads. Consumers should migrate to Stream.fromEffect.",
    "Public constructors are removed and callers must migrate.",
    94,
  ],
  miss: [
    "Corrects a spelling mistake in the getting started guide. No public APIs or runtime behavior change.",
    "The change only corrects documentation.",
    97,
  ],
  uncertain: [
    "Adjusts scheduler timing. The description does not establish whether existing applications need changes.",
    "The evidence does not establish whether callers need to change.",
    62,
  ],
}
function showSample() {
  if (!get("sample-title")) return
  get("sample-title").textContent = get("sample").selectedOptions[0].textContent
  get("sample-body").textContent = fixtures[get("sample").value][0]
  get("sample-body").hidden = !form.elements.body.checked
  get("sample-files").hidden = get("target").value === "Issues" || !form.elements.files.checked
  get("sample-files")
    .querySelectorAll("code")
    .forEach((el, i) => {
      el.textContent =
        get("sample").value === "miss"
          ? ["docs/getting-started.md", "docs/index.md"][i]
          : ["packages/effect/src/Stream.ts", "packages/effect/test/Stream.test.ts"][i]
    })
}
form.addEventListener("input", () => {
  refresh()
  invalidate()
  showSample()
})
get("target").addEventListener("change", () => {
  targetChanged()
  refresh()
})
get("sample").addEventListener("change", () => {
  invalidate()
  showSample()
})
form.addEventListener("submit", (event) => {
  event.preventDefault()
  if (!form.reportValidity()) return
  saved = snapshot()
  refresh()
  toast("Rule saved in this mockup")
})
get("cancel").addEventListener("click", () => {
  const entries = JSON.parse(saved)
  for (const el of form.elements) {
    if (!el.name) continue
    const entry = entries.find(([name]) => name === el.name)
    if (el.type === "checkbox") el.checked = Boolean(entry)
    else if (entry) el.value = entry[1]
  }
  targetChanged()
  refresh()
  invalidate()
})
get("example").addEventListener("click", () => {
  if (document.body.dataset.variant === "e") return
  get("prompt").value =
    "Does this change break compatibility for existing users?\n\nCount removed public APIs or changed behavior that requires a code migration. Exclude internal refactors and documentation changes."
  refresh()
  invalidate()
  get("prompt").focus()
})
get("test").addEventListener("click", () => {
  if (!form.reportValidity()) return
  const key = get("sample").value
  const [, reason, score] = fixtures[key]
  const uncertain = key === "uncertain" || score < Number(get("confidence").value)
  const match = key === "match" && !uncertain
  const result = get("result")
  result.dataset.state = uncertain ? "uncertain" : match ? "match" : "miss"
  result.innerHTML = `<div class="result-heading"><span class="success-dot"></span><strong>${match ? (document.body.dataset.variant === "e" ? "Match" : "Would add label") : "Labels unchanged"}</strong><span class="result-score">${score}%</span></div><span class="label-badge"></span><p></p><dl><div><dt>Decision</dt><dd>${uncertain ? "Unknown" : match ? "Match" : "No match"}</dd></div><div><dt>Minimum confidence</dt><dd>${get("confidence").value}%</dd></div></dl>`
  result.querySelector(".label-badge").textContent = get("label").value
  result.querySelector("p").textContent =
    uncertain && score < Number(get("confidence").value)
      ? "Below the minimum confidence. Existing labels are preserved."
      : reason
})
get("theme").addEventListener("click", () => document.documentElement.classList.toggle("dark"))
get("delete").addEventListener("click", () => get("delete-dialog").showModal())
get("keep").addEventListener("click", () => get("delete-dialog").close())
get("confirm-delete").addEventListener("click", () => {
  get("delete-dialog").close()
  form.hidden = true
  get("deleted").hidden = false
})
get("restore").addEventListener("click", () => {
  form.hidden = false
  get("deleted").hidden = true
  get("delete").focus()
})
refresh()
