# Voice transport probe

A throwaway deployment that answers one question before any voice work for EFF-3900 starts: can a Cloudflare Container hold a Discord voice call? It joins one test voice channel, receives audio, and records whether each step works. It shares nothing with the Janitor stack and is deleted when the test is over.

It answers three things separately:

- UDP discovery: the container sends UDP to STUN servers outside Cloudflare and to Discord's voice server, and gets the answers back on the same flow.
- DAVE decryption for a speaker already in the channel. Discord requires end-to-end encryption (DAVE) on every call. A bot joining a channel where someone is already talking is the case [discordjs/discord.js#11653](https://github.com/discordjs/discord.js/issues/11653) breaks, and auto-join hits it every time.
- Recovery: the call comes back after a dropped voice WebSocket, a destroyed connection, and a container restart (SIGTERM and SIGKILL), and stays up for an hour.

## What it keeps

No audio and no text. Received Opus frames are decoded only to measure their loudness, and the samples are dropped right away. There is no speech-to-text. The events and report hold Discord user ids of the people in the test channel, packet and frame counts, timings, connection states, the container's public address and DAVE library messages. The bot token never appears in events or logs.

The events live in the probe's Durable Object until the Worker is deleted.

## How it works

```
curl ──▶ Worker (bearer token) ──▶ VoiceProbe Durable Object ──▶ container (Node 24)
                                    events in SQLite               discord.js gateway
                                    alarm every 15 s               @discordjs/voice 0.19.2 + @snazzah/davey
                                    hard stop after 3 h            UDP ◀──▶ Discord voice
```

- `container/probe.ts` logs in with the probe bot, joins `DISCORD_CHANNEL_ID` self-muted but not deafened, subscribes to everyone who speaks and counts what happens to each packet. It wraps three library internals to count successful and failed DAVE decryptions, time IP discovery and count incoming UDP datagrams.
- `src/worker.ts` starts the container with the secrets as its environment, copies its events into SQLite every 15 seconds, restarts it if it disappears, and stops it at the time limit.
- `src/report.ts` turns the events into the checklist below.

The container also has an optional workaround for #11653 (`fix=on`): when decryption keeps failing after a transition-0 welcome, it starts the library's own recovery instead of throwing. The runbook tries the stock library first, then the workaround, so the result says whether production needs to carry a patch.

## Cost

One `basic` instance (1/4 vCPU, 1 GiB) for about 1.5 hours, plus a Worker and a Durable Object. That is a few cents, likely inside the Workers Paid plan's included container usage. The probe stops itself after `hours` (default 3, at most 6) even if nobody calls `/stop`, and the container sleeps 10 minutes after the object stops polling it.

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
probe() { curl -sS -X "$1" -H "authorization: Bearer $PROBE_TOKEN" "$PROBE_URL$2"; echo; }
probe GET /status             # "running": false, and no error
```

A new container application can take a few minutes to get its first instance. If `/start` answers `"started": false`, the alarm keeps trying every 15 seconds; check `/status` again after a minute or two.

## Run the test

About 80 minutes, most of it waiting. Each "talk" step means talking (reading anything aloud works) for about 20 seconds, starting right after the command, then checking `probe GET /status`. In `live.users`, your id should show `e2eeOk` climbing and `lastResult: "ok"`.

1. Join the test channel first and start talking. The bot must arrive while you are already there.
2. `probe POST "/start"`. Stock library, no workaround. Talk. If `e2eeFail` climbs while `e2eeOk` stays at 0, that is #11653; carry on.
3. `probe POST "/restart?signal=term&fix=on"`. Graceful restart, now with the workaround. Talk.
4. `probe POST "/drop"`. Kills the voice WebSocket; the library should resume. Talk.
5. `probe POST "/rejoin"`. Destroys the connection and joins again. Talk.
6. `probe POST "/restart?signal=kill"`. Hard kill, as a host failure would. Talk.
7. Optional: a second person joins the channel now and talks (checks a speaker who arrives after the bot).
8. Leave it running for 60 minutes. Someone can stay in the channel muted, or leave; the probe stays either way. Then talk once more.
9. Collect the result and stop:

   ```sh
   probe GET /report > voice-probe-report.md
   probe GET /events > voice-probe-events.json
   probe POST /stop
   ```

   Post `voice-probe-report.md` as a comment on EFF-3900 and attach `voice-probe-events.json`.

To repeat a run from scratch: `probe POST /stop`, `probe POST /reset`, then start again from step 1.

## Result checklist

`/report` fills this in. Each line is `pass`, `fail` or `not run`; `not run` usually means nobody talked at that point.

| Check                                                        | What it shows                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| A1 UDP round trip to a STUN server outside Cloudflare        | Outbound UDP from a deployed container gets return traffic, independent of Discord       |
| A2 Discord voice IP discovery completes                      | Discord's voice server answers the container's UDP discovery packet                      |
| A3 Voice UDP keeps arriving while someone speaks             | Audio packets reach the container, not just the handshake                                |
| B1 The call negotiates DAVE                                  | The call is end-to-end encrypted, protocol version 1 or later                            |
| B2 Speaker already present is decrypted, stock library       | Whether @discordjs/voice 0.19.2 works unpatched for auto-join                            |
| B3 Speaker already present is decrypted, with the workaround | Whether the transition-0 workaround is enough                                            |
| B4 Speaker who joins after the bot is decrypted (optional)   | MLS commits for newcomers work                                                           |
| C1 Voice WebSocket dropped                                   | The library's resume path keeps decrypting                                               |
| C2 Connection destroyed and joined again                     | A fresh voice session with someone present decrypts                                      |
| C3 SIGTERM restart                                           | A replaced container leaves cleanly, comes back and decrypts                             |
| C4 SIGKILL restart                                           | A container that dies without leaving comes back and decrypts                            |
| D1 Stays in the call for an hour                             | Long-lived UDP flow; also counts unplanned container exits and Discord-initiated resumes |

Below the checklist, the report lists every voice epoch (each time the connection became ready) with each speaker's decrypt counts, and every disruption with how long it took to get back to ready.

How the result decides the next step:

- A1 and A2 fail: Containers can't carry Discord voice. The voice part moves to a small external VM, as the design's fallback says; everything else stays on Cloudflare.
- A1 passes, A2 fails: generic UDP works but Discord doesn't answer. Look at the A2 errors before deciding; most likely the VM again.
- B1 fails: Discord didn't negotiate DAVE with this library. Stop and look at the `dave` events.
- B2 fails, B3 passes: #11653 confirmed. Production carries the workaround as a pnpm patch until the upstream fix ships.
- B3 fails: @discordjs/voice can't receive reliably here. The fallback is disgo, which needs its own probe.
- Any C fails: that recovery path needs design work; the disruption table shows where it stopped.
- D1 shows unplanned exits: their frequency feeds the reconnect and capture-gap design.

## Teardown

```sh
probe POST /stop
npx wrangler delete                        # the Worker, its Durable Object and its secrets
npx wrangler containers list               # if janitor-voice-probe-voiceprobe is still listed:
npx wrangler containers delete <ID>
npx wrangler containers images list        # remove the probe image:
npx wrangler containers images delete janitor-voice-probe-voiceprobe:<tag>
unset PROBE_TOKEN PROBE_URL
```

Then in Discord, remove the probe bot from the server, delete the `janitor-voice-probe` application in the Developer Portal (which revokes its token), and delete the test channel if it was made for this.

## When something goes wrong

- `probe GET /status` shows the last 40 events. `error` events carry the reason, for example a wrong channel id or an invalid token.
- Container output is in the Cloudflare dashboard under the Worker's Containers tab; Worker logs stream with `npx wrangler tail`.
- `/start` while the probe runs only extends the time limit. To switch the workaround on or off, use `/restart?fix=on` or `fix=off`.
- Checks for this directory: `npm ci --prefix container && npm run check` (type checks and tests).
