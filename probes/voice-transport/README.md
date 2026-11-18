# Voice transport probe

A throwaway deployment that answers one question before any voice work for EFF-3900 starts: can a Cloudflare Container hold a Discord voice call? It joins one test voice channel, receives audio, and records whether each step works. It shares nothing with the Janitor stack and is deleted when the test is over.

It answers three things separately:

- UDP discovery: the container sends UDP to STUN servers outside Cloudflare and to Discord's voice server, and gets the answers back on the same flow.
- DAVE decryption for a speaker already in the channel. Discord requires end-to-end encryption (DAVE) on every call. A bot joining a channel where someone is already talking is the case [discordjs/discord.js#11653](https://github.com/discordjs/discord.js/issues/11653) breaks, and auto-join hits it every time.
- Recovery: the call comes back after a dropped voice WebSocket, a destroyed connection, and a container restart (SIGTERM and SIGKILL), and stays up for an hour.

## What it keeps

No audio and no text. Opus frames that DAVE authenticated are decoded only to measure their loudness, and the samples are dropped right away. There is no speech-to-text.

The raw events (`/events`, `/status` and the container's stdout) hold Discord user ids of the people in the test channel, packet and frame counts, timings, connection states, the container's public address, and error and DAVE library messages. Those messages are cut to 200 characters, with the bot token and anything shaped like a token or key replaced by `[redacted]`. The library's WebSocket debug lines, which carry the voice token, are never recorded.

The report (`/report`) is what leaves the probe. It names speakers "speaker 1", "speaker 2" instead of by Discord id, and shows addresses with the last octet hidden. The raw events stay in the probe's Durable Object and are deleted with the Worker.

## How it works

```
curl ──▶ Worker (bearer token) ──▶ VoiceProbe Durable Object ──▶ container (Node 24)
                                    events in SQLite               discord.js gateway
                                    alarm every 15 s               @discordjs/voice 0.19.2 + @snazzah/davey
                                    fixed stop after 3 h           UDP ◀──▶ Discord voice
                                                                   exits by itself 2 min later
```

- `container/probe.ts` logs in with the probe bot, joins `DISCORD_CHANNEL_ID` self-muted but not deafened, subscribes to everyone who speaks and counts what happens to each packet. It wraps three library internals: DAVE decryption, where davey's own statistics tell authenticated decryption apart from plaintext let through; IP discovery, to time it; and incoming UDP, to count RTP Opus media apart from handshake traffic.
- `src/worker.ts` starts the container with the secrets as its environment, copies its events into SQLite every 15 seconds, and restarts it if it disappears. At the time limit, or on `/stop`, it ends the container and keeps retrying by alarm until the container is confirmed off. All container I/O has a timeout.
- `src/lifecycle.ts` holds those stop and retry decisions; `src/report.ts` turns the events into the checklist below.

The container also has an optional workaround for #11653 (`fix=on`): when decryption keeps failing after a transition-0 welcome, it starts the library's own recovery instead of throwing. The runbook tries the stock library first, then the workaround, so the result says whether production needs to carry a patch.

## Cost

One `basic` instance (1/4 vCPU, 1 GiB) for about 1.5 hours, plus a Worker and a Durable Object. That is a few cents, likely inside the Workers Paid plan's included container usage. The time limit is `hours` (default 3, at most 6), fixed when the probe starts; `/start` can't extend a running probe. The object ends the container at the limit even if nobody calls `/stop`, and the container leaves the call and exits on its own 2 minutes after it, in case the object has stopped working.

## Before you start

- Docker running locally. `wrangler deploy` builds the image for `linux/amd64` with it.
- Node 22 or later.
- Access to the Cloudflare account that runs Janitor (Workers Paid, which Containers need).
- A Discord server where you can add a bot and create a channel.

### A Discord bot just for the probe

Use a new application rather than Janitor's bots, so the probe's gateway session can't interfere with them.

1. In the [Developer Portal](https://discord.com/developers/applications), create an application named `janitor-voice-probe`.
2. Under **Bot**, reset the token and keep it for `DISCORD_BOT_TOKEN`. No privileged intents are needed; the probe uses Guilds and Guild Voice States only.
3. Invite it with View Channels and Connect, nothing else: `https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=1049600`
4. Create a voice channel for the test, for example `voice-probe`. In the team server, make it private to the testers and the probe bot so nobody walks into it. Don't use the coffee-chat channel.
5. With Developer Mode on (User Settings, Advanced), right-click the server and the channel to copy `DISCORD_GUILD_ID` and `DISCORD_CHANNEL_ID`.

## Deploy

```sh
cd probes/voice-transport
npm ci
npx wrangler login            # or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npx wrangler deploy           # prints the workers.dev URL

export PROBE_TOKEN=$(openssl rand -hex 32)
printf %s "$PROBE_TOKEN" | npx wrangler secret put PROBE_TOKEN
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_GUILD_ID
npx wrangler secret put DISCORD_CHANNEL_ID

export PROBE_URL=https://janitor-voice-probe.<your subdomain>.workers.dev
# curl reads the header from a file, so the token never appears in a process list.
(umask 077 && printf 'authorization: Bearer %s\n' "$PROBE_TOKEN" > .probe-auth)
probe() { curl --fail-with-body -sS -X "$1" -H @.probe-auth "$PROBE_URL$2" && echo; }
probe GET /status             # "running": false, and no error
```

`probe` exits non-zero on any HTTP error, so a refused or unconfirmed command shows as a failure. `.probe-auth` is git-ignored.

A new container application can take a few minutes to get its first instance. If `/start` answers `"started": false`, the alarm keeps trying every 15 seconds; check `/status` again after a minute or two.

## Run the test

About 80 minutes, most of it waiting. Each "talk" step means talking (reading anything aloud works) for about 20 seconds, starting right after the command, then checking `probe GET /status`. In `live.users`, your id should show `e2eeOk` and `voicedFrames` climbing and `lastResult: "ok"`.

The same tester stays in the channel from step 1 to step 6: a recovery passes only on speech from someone who was in the call before the disruption.

1. Join the test channel first and start talking. The bot must arrive while you are already there; someone who joins while the bot is connecting doesn't count as already present.
2. `probe POST "/start"`. Stock library, no workaround. Talk. If `e2eeFail` climbs while `e2eeOk` stays at 0, that is #11653; carry on.
3. `probe POST "/restart?signal=term&fix=on"`. Graceful restart, now with the workaround. Talk.
4. `probe POST "/drop"`. Kills the voice WebSocket; the library should resume. Talk.
5. `probe POST "/rejoin"`. Destroys the connection and joins again. Talk.
6. `probe POST "/restart?signal=kill"`. Hard kill, as a host failure would. Talk.
7. Optional: a second person joins the channel now and talks (checks a speaker who arrives after the bot).
8. Leave it running for 60 minutes after step 6. Someone can stay in the channel muted, or leave; the probe stays either way. Then talk once more: D1 needs speech decrypted at least an hour after the current container first became ready.
9. Collect the result and stop:

   ```sh
   probe GET /report > voice-probe-report.md
   probe POST /stop              # must print "stopped": true; see Teardown if it fails
   ```

   Post `voice-probe-report.md` as a comment on EFF-3900. Don't attach `/events`: it has Discord ids and full addresses, and the report already carries what the decision needs.

To repeat a run from scratch: `probe POST /stop`, `probe POST /reset`, then start again from step 1.

## Result checklist

`/report` fills this in. Each line is `pass`, `fail` or `not run`; `not run` usually means nobody talked at that point. A pass needs positive evidence: speech that DAVE authenticated, from the right person, after the right event.

| Check                                                          | What it shows                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1 UDP round trip to a STUN server outside Cloudflare          | Outbound UDP from a deployed container gets return traffic, independent of Discord                                                                           |
| A2 Discord voice IP discovery completes                        | Discord's voice server answers the container's UDP discovery packet                                                                                          |
| A3 Voice media arrives while someone speaks                    | RTP Opus datagrams reach the container; the discovery reply doesn't count                                                                                    |
| B1 The call negotiates DAVE                                    | The call is end-to-end encrypted, protocol version 1 or later                                                                                                |
| B2 Speaker present before the join is decrypted, stock library | Authenticated, voiced audio from someone in the channel before the bot asked to join, with @discordjs/voice 0.19.2 unpatched. Plaintext passthrough fails it |
| B3 The same, with the workaround                               | Whether the transition-0 workaround is enough; the evidence says how often it actually fired                                                                 |
| B4 Speaker who joins after the bot is decrypted (optional)     | MLS commits for newcomers work                                                                                                                               |
| C1 Voice WebSocket dropped                                     | The same process resumes, and the tester's speech decrypts before the next disruption                                                                        |
| C2 Connection destroyed and joined again                       | The same process joins afresh, and the tester's speech decrypts                                                                                              |
| C3 SIGTERM restart                                             | The old container's exit is observed, a new one joins, and the tester's speech decrypts                                                                      |
| C4 SIGKILL restart                                             | As C3, for a container that dies without leaving                                                                                                             |
| D1 One container holds the call for an hour                    | Speech decrypted at least an hour after that container first became ready. The evidence lists every interruption out of Ready, and unplanned container exits |

Below the checklist, the report lists every voice epoch (each time the connection became ready) with each speaker's decrypt counts, and every disruption with how long it took to get back to ready.

How the result decides the next step:

- A1 and A2 fail: Containers can't carry Discord voice. The voice part moves to a small external VM, as the design's fallback says; everything else stays on Cloudflare.
- A1 passes, A2 fails: generic UDP works but Discord doesn't answer. Look at the A2 errors before deciding; most likely the VM again.
- B1 fails: Discord didn't negotiate DAVE with this library. Stop and look at the `dave` events.
- B2 fails, B3 passes: #11653 confirmed. Production carries the workaround as a pnpm patch until the upstream fix ships.
- B3 fails: @discordjs/voice can't receive reliably here. The fallback is disgo, which needs its own probe.
- Any C fails: that recovery path needs design work; the disruption table shows where it stopped.
- D1 shows interruptions or unplanned exits: their frequency and length feed the reconnect and capture-gap design.

## Teardown

```sh
probe POST /stop      # must print "stopped": true
probe GET /status     # must show "running": false
```

If `/stop` fails with HTTP 503, the container didn't confirm it was off. The object keeps retrying every 15 seconds; run `/stop` again until it prints `"stopped": true`. Only then delete:

```sh
npx wrangler delete                        # the Worker, its Durable Object, its events and its secrets
npx wrangler containers list               # must not list janitor-voice-probe-voiceprobe; if it does:
npx wrangler containers delete <ID>        #   delete it and list again
npx wrangler containers images list        # must not list janitor-voice-probe-voiceprobe; if it does:
npx wrangler containers images delete janitor-voice-probe-voiceprobe:<tag>   # each tag, then list again
rm .probe-auth && unset PROBE_TOKEN PROBE_URL
```

Then in Discord, remove the probe bot from the server, delete the `janitor-voice-probe` application in the Developer Portal (which revokes its token), and delete the test channel if it was made for this.

## When something goes wrong

- `probe GET /status` shows the last 40 events. `error` events carry the reason, for example a wrong channel id or an invalid token.
- Container output is in the Cloudflare dashboard under the Worker's Containers tab; Worker logs stream with `npx wrangler tail`.
- `/start` while the probe runs is refused, so the time limit can't move. To switch the workaround on or off, use `/restart?fix=on` or `fix=off`.
- Checks for this directory: `npm ci --prefix container && npm run check` (type checks and tests).
