/* Literal tokens remain editable text; references determine the evidence set. */
;(() => {
  const prompt = document.getElementById("prompt")
  const menu = document.getElementById("fact-menu")
  const options = document.getElementById("fact-options")
  const target = document.getElementById("target")
  const slider = document.getElementById("confidence")
  const catalog = [
    ["title", "Title"],
    ["body", "Description"],
    ["author", "Author login"],
    ["state", "Open or closed"],
    ["labels", "Current label IDs"],
    ["draft", "Is a draft PR", true],
    ["baseRef", "Base branch", true],
    ["headSha", "Head commit SHA", true],
    ["changedFiles", "Changed paths and statuses", true],
    ["checks", "Check runs", true],
    ["reviews", "PR reviews", true],
  ]
  let matches = [],
    active = 0,
    anchor = null
  const eligible = () => catalog.filter((fact) => !fact[2] || target.value !== "Issues")
  const close = () => {
    menu.hidden = true
    prompt.setAttribute("aria-expanded", "false")
    prompt.removeAttribute("aria-activedescendant")
    anchor = null
  }
  const validate = () => {
    const names = [...prompt.value.matchAll(/\{\{fact:([^}]+)\}\}/g)].map((match) => match[1])
    const bad = names.find((name) => !eligible().some((fact) => fact[0] === name))
    const incomplete = prompt.value.replace(/\{\{fact:[^}]+\}\}/g, "").includes("{{")
    const message = bad
      ? `“${bad}” is not an available fact for ${target.value.toLowerCase()}.`
      : incomplete
        ? "Complete the fact reference before saving."
        : !names.length
          ? "Reference at least one fact using {{fact:...}}."
          : new Set(names).size > 8
            ? "Use at most 8 different facts."
            : ""
    prompt.setCustomValidity(message || (prompt.value.trim() ? "" : "Enter instructions."))
    document.getElementById("fact-error").textContent = message
    document.getElementById("fact-error").hidden = !message
  }
  const paint = () => {
    options.replaceChildren()
    matches.forEach(([name, description], i) => {
      const option = document.createElement("div")
      option.className = "fact-option"
      option.id = `fact-option-${i}`
      option.setAttribute("role", "option")
      option.setAttribute("aria-selected", String(i === active))
      const token = document.createElement("code")
      token.textContent = `{{fact:${name}}}`
      const detail = document.createElement("span")
      detail.textContent = description
      option.append(token, detail)
      option.addEventListener("pointerdown", (event) => {
        event.preventDefault()
        insert(i)
      })
      options.append(option)
    })
    if (!matches.length) options.textContent = "No matching facts"
    if (matches.length) {
      prompt.setAttribute("aria-activedescendant", `fact-option-${active}`)
      options.children[active].scrollIntoView({ block: "nearest" })
    } else prompt.removeAttribute("aria-activedescendant")
  }
  const suggest = () => {
    const before = prompt.value.slice(0, prompt.selectionStart)
    const match = before.match(/\{\{(?:fact:)?([\w]*)$/)
    if (!match || prompt.selectionStart !== prompt.selectionEnd) {
      close()
      return
    }
    anchor = prompt.selectionStart - match[0].length
    matches = eligible().filter(([name, description]) =>
      `${name} ${description}`.toLowerCase().includes(match[1].toLowerCase()),
    )
    active = 0
    menu.hidden = false
    prompt.setAttribute("aria-expanded", "true")
    paint()
  }
  const insert = (index) => {
    if (anchor === null || !matches[index]) return
    const end =
      prompt.selectionStart + (prompt.value.slice(prompt.selectionStart).startsWith("}}") ? 2 : 0)
    const token = `{{fact:${matches[index][0]}}}`
    if (prompt.value.length - (end - anchor) + token.length > prompt.maxLength) return
    prompt.setRangeText(token, anchor, end, "end")
    close()
    prompt.focus()
    prompt.dispatchEvent(new Event("input", { bubbles: true }))
  }
  prompt.addEventListener("input", suggest)
  prompt.addEventListener("click", suggest)
  prompt.addEventListener("keydown", (event) => {
    if (menu.hidden) return
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    } else if (["ArrowDown", "ArrowUp"].includes(event.key) && matches.length) {
      event.preventDefault()
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length
      paint()
    } else if (["Enter", "Tab"].includes(event.key) && matches.length) {
      event.preventDefault()
      insert(active)
    }
  })
  document.addEventListener("pointerdown", (event) => {
    if (event.target !== prompt && !menu.contains(event.target)) close()
  })
  prompt.addEventListener("blur", close)
  document.getElementById("example").addEventListener("click", () => {
    prompt.focus()
    prompt.setRangeText("{{", prompt.selectionStart, prompt.selectionEnd, "end")
    prompt.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const sync = () => {
    validate()
    slider.style.setProperty("--fill", `${slider.value}%`)
    document
      .querySelectorAll("[data-confidence]")
      .forEach((button) =>
        button.setAttribute("aria-pressed", String(button.dataset.confidence === slider.value)),
      )
  }
  document.getElementById("rule-form").addEventListener("input", sync)
  target.addEventListener("change", () => {
    close()
    sync()
  })
  document.getElementById("cancel").addEventListener("click", () => {
    close()
    sync()
  })
  document.querySelectorAll("[data-confidence]").forEach((button) =>
    button.addEventListener("click", () => {
      slider.value = button.dataset.confidence
      slider.dispatchEvent(new Event("input", { bubbles: true }))
    }),
  )
  sync()
})()
