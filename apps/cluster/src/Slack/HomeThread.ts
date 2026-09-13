/** The permalink teammates open to join a session's home thread. */
export const homeThreadUrl = (channelId: string, threadTs: string) =>
  `https://app.slack.com/archives/${channelId}/p${threadTs.replace(".", "")}`
