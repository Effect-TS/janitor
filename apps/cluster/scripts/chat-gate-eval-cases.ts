/**
 * The reply gate's eval set (EFF-3137): threads with a labelled newest message,
 * replayed through the real gate by `chat-gate-eval.ts`. Add a case whenever
 * the gate gets a message wrong, and rerun the set when the prompt, model or
 * threshold changes.
 *
 * Everything here is written by hand: Ada is the admitted user janitor is
 * talking to, Bruno, Dev and Eli other admitted users, Gus an outsider. Two
 * threads copy the shape of real false negatives from 2026-10-29 without
 * their words: an instruction sent straight after janitor's answer, by the
 * person janitor answered. Real conversations are not committed; the runner
 * replays them from a gitignored private corpus with the same shape.
 *
 * A bot message's `answers` is who janitor was replying to. The runner uses
 * it to score the structural signals the issue proposes, not the gate.
 * `borderline` marks a label reasonable people could dispute; the runner
 * reports those separately.
 */
import * as Schema from "effect/Schema"
import { AuthorClass } from "@janitor/domain/Chat/Session"

export const GateEvalMessage = Schema.Struct({
  /** Unique within its thread; never a platform's message id. */
  id: Schema.String,
  author: Schema.Struct({ id: Schema.String, name: Schema.String }),
  class: AuthorClass,
  /** With mentions of the bot removed, as ingress hands it over. */
  text: Schema.String,
  mentionsBot: Schema.Boolean,
  /** On janitor's replies: the author id of the message it answered. */
  answers: Schema.optionalKey(Schema.String),
})
export type GateEvalMessage = typeof GateEvalMessage.Type

export const GateEvalThread = Schema.Struct({
  name: Schema.String,
  /** Oldest first. */
  messages: Schema.Array(GateEvalMessage),
})
export type GateEvalThread = typeof GateEvalThread.Type

export const GateEvalCase = Schema.Struct({
  name: Schema.String,
  thread: Schema.String,
  /** The message id the gate decides on; the thread up to it is the context. */
  newest: Schema.String,
  /** Whether the gate should pass it. */
  expected: Schema.Boolean,
  source: Schema.Literals(["handwritten", "production"]),
  /** The probability the gate logged in production, for a private case. */
  recorded: Schema.optionalKey(Schema.Number),
  /**
   * When `recorded` predates the current gate: before PR #148 janitor's
   * replies weren't in the context, and between #148 and #150 the prompt was
   * worded differently. Absent means the gate as it is now.
   */
  recordedUnder: Schema.optionalKey(Schema.Literals(["before-#148", "#148-prompt"])),
  borderline: Schema.optionalKey(Schema.Boolean),
  note: Schema.optionalKey(Schema.String),
})
export type GateEvalCase = typeof GateEvalCase.Type

/** What `chat-gate-eval.ts --private <file>` reads: the same shape as this module. */
export const GateEvalCorpus = Schema.Struct({
  threads: Schema.Array(GateEvalThread),
  cases: Schema.Array(GateEvalCase),
})

// ---- people

const ada = { id: "U0ADA", name: "Ada" }
const bruno = { id: "U0BRUNO", name: "Bruno" }
const dev = { id: "U0DEV", name: "Dev" }
const eli = { id: "U0ELI", name: "Eli" }
const gus = { id: "U0GUS", name: "Gus" }
const effectBot = { id: "U0EFFECTBOT", name: "Effect Bot" }
const janitor = { id: "janitor", name: "janitor" }

const says = (
  id: string,
  author: typeof ada,
  text: string,
  mentionsBot = false,
  authorClass: AuthorClass = "admitted",
): GateEvalMessage => ({
  id,
  author,
  class: authorClass,
  text,
  mentionsBot,
})
const replies = (id: string, text: string, answers = ada.id): GateEvalMessage => ({
  id,
  author: janitor,
  class: "bot",
  text,
  mentionsBot: false,
  answers,
})

// ---- short threads

/** janitor answered Ada's mention with a PR; Ada's next message is the case. */
const afterPullRequest = (name: string, last: GateEvalMessage): GateEvalThread => ({
  name,
  messages: [
    says("1", ada, "can you bump effect to 4.1 in the discord bot", true),
    replies(
      "2",
      "Opened PR #321 updating Effect and companion packages to 4.1.0. No source changes needed; CI is green.",
    ),
    last,
  ],
})

/** janitor explained a skipped preview and proposed a fix; Ada's next message is the case. */
const afterProposal = (name: string, last: GateEvalMessage): GateEvalThread => ({
  name,
  messages: [
    says("1", ada, "why isn't the preview deploying on my PR?", true),
    replies(
      "2",
      "It's being skipped, not failing: the preview workflow checks the PR's author_association, which GitHub reports as CONTRIBUTOR for you. I can open a PR that checks write permission instead. Want me to?",
    ),
    last,
  ],
})

/** janitor answered Ada's question; Ada's next message is the case. */
const afterAnswer = (name: string, last: GateEvalMessage): GateEvalThread => ({
  name,
  messages: [
    says("1", ada, "why does makeUtc use Object.defineProperty per instance?", true),
    replies(
      "2",
      "To keep the partsUtc cache non-enumerable, so structural comparisons such as assert.deepStrictEqual don't see it. Effect's own Equal uses DateTime's custom implementation, so that part wouldn't change if it were removed.",
    ),
    last,
  ],
})

// ---- the two shapes of the real false negatives

/**
 * A Discord forum thread: an outsider's performance report, two people
 * chatting, then Ada and janitor going back and forth without mentions.
 * The last message is the shape of EFF-3137's screenshot: an instruction
 * straight after janitor's long answer, from the person it answered.
 */
const discordFollowUp: GateEvalThread = {
  name: "hw-discord-follow-up",
  messages: [
    says(
      "1",
      gus,
      "> **Cron: `make` parses the expression on every instance, about 2× slower than needed**\n>\n> `internal/cron.ts` `make` defines a lazy `fields` property with `Object.defineProperty` on each instance. A benchmark constructing 1M crons takes 410ms against 190ms with a plain property.",
      false,
      "outsider",
    ),
    says("2", effectBot, "", false, "bot"),
    says("3", effectBot, "", false, "bot"),
    says("4", bruno, "That's expected, it's <@U0ADA>'s code"),
    says("5", eli, "Ada again"),
    says("6", ada, "can we remove it safely? I don't think it was always there", true),
    replies(
      "7",
      "Yes, for Cron's own logic: `fields` is a lazy cache, and a missing one reads as `undefined`, so removing the initialization still lets every accessor fill it on first use. The only reason to define it up front is to keep the property non-enumerable: with a plain assignment it shows up in `Object.keys`, spreads and structural comparisons once it has been filled, which is probably why the property is defined before anything reads it.",
    ),
    says("8", ada, "Hmm I wonder why it was added"),
    says("9", ada, "any ideas?", true),
    replies(
      "10",
      "My best guess is to keep lazy caches invisible to structural comparisons. Otherwise, calling `next` on one of two identical Crons fills its cache and makes them compare differently in generic deep-equality helpers, even though nothing meaningful changed.",
    ),
    says(
      "11",
      ada,
      "Ah right, structural equality. But Cron has its own Equal implementation anyway",
    ),
    says("12", ada, "Can we remove it without any regressions?"),
    replies(
      "13",
      "You're right that Effect's `Equal.equals` uses Cron's own implementation, so filling the cache won't affect it or hashing. But it isn't strictly without regressions: generic comparators such as Node's `assert.deepStrictEqual` don't use the Equal trait. If `fields` becomes enumerable, two identical Crons can compare differently after calling `next` on only one of them, and `Object.keys` and spreads change too. Removing it is safe for Effect's equality and Cron's own calculations, but not behavior-preserving for outside structural comparisons. To keep those, the cache would have to stay non-enumerable or move off the instance, for example into a WeakMap.",
    ),
    says(
      "14",
      ada,
      "Open an issue to look into the WeakMap option and what it does to performance",
    ),
  ],
}

/**
 * A Slack thread: Ada's mention got a PR, other people chat about it, one
 * of them mentions janitor, janitor answers that person, then Ada tells
 * janitor what to do with the PR without a mention.
 */
const slackClosePullRequest: GateEvalThread = {
  name: "hw-slack-close-pr",
  messages: [
    says("1", ada, "make the website's homepage title pink", true),
    replies(
      "2",
      "Ada: <https://github.com/acme/website/pull/1647|PR opened> to make the homepage title pink, keeping the shine animation. Not merged or deployed.",
    ),
    says("3", ada, "Can you try bumping the PR to trigger CI again"),
    replies(
      "4",
      "Bumped <https://github.com/acme/website/pull/1647|the pink-title PR> by merging in latest `main`. Check, Test and Preview are all green now.",
    ),
    says("5", eli, "<@U0DEV> this is gorgeous"),
    says("6", eli, "we might have to keep it"),
    says("7", dev, "we must"),
    says("8", eli, "can you tell <@U0DEV> why a pink title is a good idea?", true),
    replies(
      "9",
      "The case for pink: it pulls the eye straight to the headline against the dark background, it gives an otherwise monochrome page some personality, and it is a cheap way to signal that the site changed. The case against: it clashes with the brand palette and reads as a joke to first-time visitors.",
      eli.id,
    ),
    says("10", ada, "Ok, you can close the PR now"),
  ],
}

// ---- the set

export const threads: ReadonlyArray<GateEvalThread> = [
  afterPullRequest("hw-thanks", says("3", ada, "thanks")),
  afterPullRequest("hw-thats-all", says("3", ada, "ok thanks, that's all for now")),
  afterPullRequest("hw-lol", says("3", ada, "lol")),
  afterPullRequest("hw-also", says("3", ada, "Can you also add a changeset?")),
  afterProposal("hw-no-thanks", says("3", ada, "no thanks")),
  afterProposal("hw-leave-it", says("3", ada, "no, leave it as is")),
  afterProposal("hw-go-ahead", says("3", ada, "Go ahead")),
  afterProposal("hw-yes-please", says("3", ada, "yes please")),
  afterAnswer("hw-follow-up-instruction", says("3", ada, "Open an issue to track removing it")),
  afterAnswer("hw-what-about", says("3", ada, "what about the Slack side?")),
  afterAnswer(
    "hw-to-another-person",
    says("3", ada, "Bruno, can you review it when you have a minute?"),
  ),
  {
    name: "hw-two-humans",
    messages: [
      says("1", ada, "can you bump effect to 4.1 in the discord bot", true),
      replies(
        "2",
        "Opened PR #321 updating Effect and companion packages to 4.1.0. No source changes needed; CI is green.",
      ),
      says("3", bruno, "Ada, do you want this merged before the release?"),
      says("4", ada, "not today, let's wait for the release first"),
    ],
  },
  discordFollowUp,
  slackClosePullRequest,
]

const handwritten = (
  name: string,
  newest: string,
  expected: boolean,
  note: string,
  options: { readonly thread?: string; readonly borderline?: boolean } = {},
): GateEvalCase => ({
  name,
  thread: options.thread ?? name,
  newest,
  expected,
  source: "handwritten",
  note,
  ...(options.borderline ? { borderline: true } : {}),
})

export const cases: ReadonlyArray<GateEvalCase> = [
  handwritten("hw-thanks", "3", false, "acknowledgement"),
  handwritten("hw-thats-all", "3", false, "acknowledgement"),
  handwritten("hw-lol", "3", false, "acknowledgement"),
  handwritten("hw-also", "3", true, "follow-up instruction"),
  handwritten("hw-no-thanks", "3", false, "refuses janitor's proposal"),
  handwritten("hw-leave-it", "3", false, "refuses janitor's proposal"),
  handwritten("hw-go-ahead", "3", true, "approves janitor's proposal"),
  handwritten("hw-yes-please", "3", true, "approves janitor's proposal"),
  handwritten(
    "hw-follow-up-instruction",
    "3",
    true,
    "an instruction straight after janitor's answer, in a short thread",
  ),
  handwritten("hw-what-about", "3", true, "follow-up question"),
  handwritten(
    "hw-to-another-person",
    "3",
    false,
    "the person janitor answered addresses someone else by name",
  ),
  handwritten(
    "hw-two-humans/bruno",
    "3",
    false,
    "another person asks the person janitor answered",
    {
      thread: "hw-two-humans",
    },
  ),
  handwritten(
    "hw-two-humans/ada",
    "4",
    false,
    "the person janitor answered replies to the other person",
    { thread: "hw-two-humans" },
  ),
  handwritten(
    "hw-discord-follow-up/musing",
    "8",
    true,
    "musing after janitor's answer; the author then mentioned janitor to ask the same thing",
    { thread: "hw-discord-follow-up", borderline: true },
  ),
  handwritten(
    "hw-discord-follow-up/question",
    "12",
    true,
    "a question to janitor without a mention, after its answer",
    { thread: "hw-discord-follow-up" },
  ),
  handwritten(
    "hw-discord-follow-up/instruction",
    "14",
    true,
    "the shape of EFF-3137's screenshot: an instruction straight after janitor's long answer, from the person it answered; the real one scored 0.26",
    { thread: "hw-discord-follow-up" },
  ),
  handwritten(
    "hw-slack-close-pr/instruction",
    "10",
    true,
    "the shape of the other confirmed false negative: an instruction about janitor's PR after other people chatted and janitor answered one of them; the real one scored 0.47 before PR #148",
    { thread: "hw-slack-close-pr" },
  ),
]
