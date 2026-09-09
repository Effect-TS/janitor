import { describe, it, expect } from "vite-plus/test"
import * as DateTime from "effect/DateTime"
import * as Activity from "@/components/activity"
import type { ActivityEntry } from "@/components/labeling-wire"
const entry = (id: string, number = 5): ActivityEntry => ({
  id,
  number,
  title: "Fix interruption",
  kind: "pull_request",
  createdAt: DateTime.makeUnsafe("2026-09-07T10:00:00Z"),
  outcome: "evaluated",
  detail: null,
  revision: 1,
  plan: null,
  actions: [],
})
const start = () =>
  Activity.update(
    Activity.init(),
    Activity.Message.Activated({ repositoryId: "701", active: true }),
  ).model
const loaded = () => {
  const model = start()
  return Activity.update(
    model,
    Activity.Message.Loaded({
      generation: model.generation,
      older: false,
      page: { entries: [entry("a")], cursor: { number: 5, generation: "1", revision: 1 } },
    }),
  ).model
}
describe("Activity", () => {
  it("defaults to collapsed groups and only expands selected histories", () => {
    const model = { ...loaded(), entries: [entry("a"), entry("b", 6), entry("c")] }
    expect(model.mode).toBe("grouped")
    expect(Activity.rows(model).map((row) => row.kind)).toEqual(["group", "group"])
    const grouped = Activity.update(model, Activity.Message.ToggledGroup({ number: 5 })).model
    expect(Activity.rows(grouped).map((row) => row.kind)).toEqual([
      "group",
      "event",
      "event",
      "group",
    ])
    expect(
      Activity.rows(Activity.update(grouped, Activity.Message.ToggledGroup({ number: 5 })).model),
    ).toHaveLength(2)
    const withNewSubject = { ...grouped, entries: [...grouped.entries, entry("d", 7)] }
    expect(Activity.rows(withNewSubject).at(-1)?.kind).toBe("group")
    const journal = Activity.update(model, Activity.Message.ChangedMode({ mode: "journal" })).model
    const expanded = Activity.update(journal, Activity.Message.ToggledEvent({ id: "a" })).model
    expect(Activity.rowHeight(Activity.rows(expanded)[0]!)).toBe(420)
  })
  it("stages new activity without moving the current list and accepts it explicitly", () => {
    const model = {
      ...loaded(),
      mode: "journal" as const,
      journal: { ...loaded().journal, scrollTop: 960 },
    }
    const next = Activity.update(
      model,
      Activity.Message.Loaded({
        generation: model.generation,
        older: false,
        page: { entries: [entry("new"), entry("a")], cursor: null },
      }),
    ).model
    expect(next.entries).toEqual(model.entries)
    expect(next.journal.scrollTop).toBe(960)
    expect(next.pending?.entries[0]?.id).toBe("new")
    const accepted = Activity.update(next, Activity.Message.ClickedNew())
    expect(accepted.model.entries[0]?.id).toBe("new")
    expect(accepted.model.pending).toBeNull()
    expect(accepted.commands?.length).toBe(1)
  })
  it("keeps separate view positions and restores the target container on remount", () => {
    const model = {
      ...loaded(),
      journal: { ...loaded().journal, scrollTop: 960 },
      grouped: { ...loaded().grouped, scrollTop: 144 },
    }
    const grouped = Activity.update(model, Activity.Message.ChangedMode({ mode: "grouped" })).model
    expect(grouped.grouped.scrollTop).toBe(144)
    expect(grouped.grouped.measurement._tag).toBe("Unmeasured")
    const journal = Activity.update(
      grouped,
      Activity.Message.ChangedMode({ mode: "journal" }),
    ).model
    expect(journal.journal.scrollTop).toBe(960)
    expect(Activity.update(journal, Activity.Message.ChangedMode({ mode: "journal" })).model).toBe(
      journal,
    )
  })
  it("fences stale filters and repositories and deduplicates older pages", () => {
    const model = loaded()
    const searched = Activity.update(model, Activity.Message.ChangedSearch({ value: "another" }))
    expect(searched.commands).toBeUndefined()
    expect(searched.model.searchPending).toBe(true)
    expect(Activity.update(searched.model, Activity.Message.Polled()).commands).toBeUndefined()
    expect(
      Activity.update(
        searched.model,
        Activity.Message.Loaded({
          generation: model.generation,
          older: false,
          page: { entries: [entry("old")], cursor: null },
        }),
      ).model,
    ).toBe(searched.model)
    const another = Activity.update(
      model,
      Activity.Message.Activated({ repositoryId: "702", active: true }),
    ).model
    expect(another.entries).toHaveLength(0)
    expect(
      Activity.update(
        another,
        Activity.Message.Failed({ generation: model.generation, reason: "old" }),
      ).model,
    ).toBe(another)
    const more = Activity.update(
      model,
      Activity.Message.Loaded({
        generation: model.generation,
        older: true,
        page: { entries: [entry("a"), entry("b")], cursor: null },
      }),
    ).model
    expect(more.entries.map((entry) => entry.id)).toEqual(["a", "b"])
  })
  it("distinguishes failed evaluations from label writes, including partial success", () => {
    const failed = {
      ...entry("a"),
      evaluations: [
        { ruleId: "ai", outcome: "failed", reason: "Provider unavailable. Try again." },
      ],
    }
    expect(Activity.outcome(failed).label).toBe("Evaluation failed · labels unchanged")
    expect(
      Activity.outcome({
        ...failed,
        actions: [
          {
            ruleId: "other",
            labelId: "1",
            name: "review",
            color: null,
            action: "add",
            status: "applied",
            detail: null,
          },
        ],
      }).label,
    ).toBe("Labels updated · evaluation failed")
  })
  it("never calls a planned or failed write an applied label change", () => {
    const action = {
      labelId: "1",
      name: "bug",
      color: "d73a4a",
      ruleId: "r",
      action: "add" as const,
      status: "planned" as const,
      detail: null,
    }
    expect(Activity.outcome({ ...entry("a"), actions: [action] }).label).toBe("Pending")
    expect(
      Activity.outcome({ ...entry("a"), actions: [{ ...action, status: "failed" }] }).label,
    ).toBe("Label update failed")
    expect(
      Activity.outcome({ ...entry("a"), actions: [{ ...action, status: "applied" }] }).label,
    ).toBe("Labels updated")
  })
})
