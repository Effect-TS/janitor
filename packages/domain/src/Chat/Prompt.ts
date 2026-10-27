/** Steered into a turn at minute 17: three minutes before its hard deadline. */
export const wrapUpMessage =
  "Time is nearly up: this turn ends in about three minutes. Stop starting new work, commit and push anything worth keeping, then reply with where things stand."

/** The message a turn continues from after a lost sandbox or a restart. */
export const resumeMessage =
  "The sandbox was replaced; continue from where you left off. This sandbox is new: every edit since your last push is gone. Before redoing a step, check with `gh` and `multica` what you already pushed, opened, merged or commented."

/** The one reply a thread gets while the kill switch is on. */
export const switchedOffMessage =
  "I'm switched off for now. Messages here are kept as context for when I'm back."
