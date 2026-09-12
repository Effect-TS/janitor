import type { AccountView, RosterEntry, TeammateSummary } from "@janitor/domain/Team/Account"
import { TeammateId, LinkId } from "@janitor/domain/Team/Account"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Scene } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import * as Account from "@/components/account"

const at = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")
const me: TeammateSummary = {
  teammateId: TeammateId.make("t-me"),
  issuer: "https://team.cloudflareaccess.test",
  subject: "me",
  email: "me@example.com",
  role: "member",
  status: "active",
  createdAt: at,
  removedAt: null,
}
const slackLink = {
  linkId: LinkId.make("l-slack"),
  platform: "slack" as const,
  workspaceId: "T1",
  accountId: "U1",
  displayName: "Me",
  status: "active" as const,
  linkedAt: at,
  endedAt: null,
}
const other: RosterEntry = {
  ...me,
  teammateId: TeammateId.make("t-other"),
  subject: "other",
  email: null,
  links: [slackLink],
}
const gone: RosterEntry = {
  ...other,
  teammateId: TeammateId.make("t-gone"),
  subject: "gone",
  status: "removed",
  removedAt: at,
  links: [{ ...slackLink, status: "disabled" }],
}
const memberView: AccountView = {
  teammate: me,
  links: [slackLink],
  linking: { slack: true, github: false },
  team: null,
}
const adminView: AccountView = {
  teammate: { ...me, role: "admin" },
  links: [],
  linking: { slack: true, github: true },
  team: [{ ...me, role: "admin", links: [] }, other, gone],
}

const scene = (
  view: AccountView,
  ...steps: Array<Scene.SceneStep<Account.Model, Account.Message, Account.OutMessage>>
) =>
  Scene.scene(
    { update: Account.update, view: Scene.withViewInputs(Account.view, {})() },
    Scene.given(Account.init()),
    Scene.Mount.resolve(Account.Open, Account.Message.LoadRequested()),
    Scene.Command.resolve(Account.Load, Account.Message.Loaded({ requestId: 1, view })),
    ...steps,
  )

describe("Account page", () => {
  it("shows connected accounts and only configured platforms can be connected", () => {
    scene(
      memberView,
      Scene.expect(Scene.text("me@example.com")).toExist(),
      Scene.expect(Scene.text("Connected as Me in workspace T1.")).toExist(),
      Scene.expect(Scene.role("button", { name: "Replace Slack account" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Disconnect" })).toExist(),
      Scene.expect(Scene.text("GitHub linking is not configured for this deployment.")).toExist(),
      Scene.expect(Scene.role("button", { name: "Connect GitHub" })).toBeAbsent(),
      Scene.expect(Scene.text("Team")).toBeAbsent(),
    )
  })

  it("lets admins change roles, remove and restore teammates", () => {
    scene(
      adminView,
      Scene.expect(Scene.text("me@example.com (you)")).toExist(),
      Scene.expect(Scene.text("Admin · Active")).toExist(),
      Scene.expect(Scene.text("Member · Active · Slack: Me")).toExist(),
      Scene.expect(Scene.text("Member · Removed")).toExist(),
      Scene.expect(Scene.role("button", { name: "Make admin" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Restore" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Connect Slack" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Connect GitHub" })).toExist(),
    )
  })

  it("explains a removed membership instead of an empty page", () => {
    Scene.scene(
      { update: Account.update, view: Scene.withViewInputs(Account.view, {})() },
      Scene.given(Account.init()),
      Scene.Mount.resolve(Account.Open, Account.Message.LoadRequested()),
      Scene.Command.resolve(
        Account.Load,
        Account.Message.LoadFailed({
          requestId: 1,
          reason: "Your Janitor membership was removed. Ask an admin to restore it.",
        }),
      ),
      Scene.expect(
        Scene.text("Your Janitor membership was removed. Ask an admin to restore it."),
      ).toExist(),
      Scene.expect(Scene.text("Loading your account…")).toBeAbsent(),
    )
  })
})

describe("Account linking flow", () => {
  it("opens the platform once the API returns its URL and ignores stale replies", () => {
    const started = Account.update(
      Account.init(),
      Account.Message.ClickedConnect({ platform: "slack" }),
    )
    expect(started.commands?.[0]?.name).toBe("StartAccountLink")
    expect(
      Account.update(started.model, Account.Message.ClickedConnect({ platform: "github" }))
        .commands,
    ).toBeUndefined()
    const opened = Account.update(
      started.model,
      Account.Message.GotPlatformUrl({
        url: "https://slack.com/openid/connect/authorize?x",
        operationId: 1,
      }),
    )
    expect(opened.outMessage).toEqual(
      Account.OutMessage.OpenPlatform({ url: "https://slack.com/openid/connect/authorize?x" }),
    )
    expect(Option.isNone(opened.model.pending)).toBe(true)
    const stale = Account.update(
      opened.model,
      Account.Message.GotPlatformUrl({ url: "https://elsewhere", operationId: 1 }),
    )
    expect(stale.outMessage).toBeUndefined()
  })

  it("completes a platform return, then reloads and drops the callback address", () => {
    const returning = Account.returned(Account.init(), {
      platform: "github",
      code: "abc",
      state: "xyz",
    })
    expect(returning.commands?.[0]?.name).toBe("CompleteAccountLink")
    const done = Account.update(
      returning.model,
      Account.Message.Returned({
        operationId: 1,
        linked: { ...slackLink, platform: "github", workspaceId: "github.com", accountId: "42" },
      }),
    )
    expect(done.outMessage).toEqual(Account.OutMessage.FinishedReturn())
    expect(done.model.notice).toBe("GitHub account connected.")
    expect(done.commands?.[0]?.name).toBe("LoadAccount")
    const failed = Account.update(
      Account.returned(Account.init(), { platform: "slack", code: "abc", state: "used" }).model,
      Account.Message.Failed({ operationId: 1, reason: "This connection attempt expired." }),
    )
    expect(failed.outMessage).toEqual(Account.OutMessage.FinishedReturn())
    expect(failed.model.error).toEqual(Option.some("This connection attempt expired."))
  })
})
