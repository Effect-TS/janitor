import { checkRunOutput } from "@janitor/domain/PullRequestReview/Render"
import * as Effect from "effect/Effect"
import type { PullRequestGitHub } from "./GitHub.ts"
import { PullRequestReviewStore, type SkippedRun } from "./Store.ts"

/**
 * Records a run janitor won't start (EFF-1930 point 7): a neutral
 * `janitor/review` check run on the head saying why and that `/janitor`
 * reviews anyway, then the `skipped` row. Admission records oversized skips;
 * the run entity's `Skip` handler records run-cap skips.
 */
export const recordSkip = (github: PullRequestGitHub, run: SkippedRun) =>
  Effect.gen(function* () {
    const store = yield* PullRequestReviewStore
    yield* github.upsertCheckRun({
      headSha: run.headSha,
      state: { status: "completed", conclusion: "neutral" },
      output: checkRunOutput({ _tag: "Skipped", reason: run.reason }),
    })
    yield* store.skip(run)
  })
