// EFF-1655 spike: a unix-socket proxy in front of podman's Docker-compatible
// API. workerd's container client sends `HostConfig.MemorySwappiness` when it
// creates containers, which crun on cgroup v2 rejects ("cannot set memory
// swappiness"). Docker ignores the field; podman 500s. Strip it here and
// forward everything else untouched (including hijacked/upgraded streams).
import * as http from "node:http"
import * as net from "node:net"
import * as fs from "node:fs"

const upstream = process.env.PODMAN_SOCK ?? "/run/user/1000/podman/podman.sock"
const listen = process.env.PROXY_SOCK ?? "/tmp/eff1655-docker.sock"
const log = (...a) => console.log(new Date().toISOString(), ...a)

const scrub = (json) => {
  const body = JSON.parse(json)
  const hc = body.HostConfig ?? {}
  const removed = []
  for (const key of ["MemorySwappiness"]) {
    if (key in hc) {
      delete hc[key]
      removed.push(key)
    }
  }
  return { body: JSON.stringify(body), removed }
}

const server = http.createServer((req, res) => {
  const isCreate = req.method === "POST" && /^\/(v[\d.]+\/)?containers\/create/.test(req.url ?? "")
  const forward = (bodyBuffer) => {
    const headers = { ...req.headers }
    if (bodyBuffer !== undefined) headers["content-length"] = String(bodyBuffer.length)
    delete headers["transfer-encoding"]
    const up = http.request({ socketPath: upstream, method: req.method, path: req.url, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
      if (isCreate || (upRes.statusCode ?? 0) >= 400) {
        let out = ""
        upRes.on("data", (c) => (out += c))
        upRes.on("end", () => log(req.method, req.url, "->", upRes.statusCode, out.slice(0, 300)))
      }
    })
    up.on("error", (e) => {
      log("upstream error", req.method, req.url, e.message)
      if (!res.headersSent) res.writeHead(502)
      res.end(String(e))
    })
    if (bodyBuffer !== undefined) up.end(bodyBuffer)
    else req.pipe(up)
  }
  if (isCreate) {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      try {
        const { body, removed } = scrub(raw)
        log("create", req.url, "stripped:", removed.join(",") || "nothing")
        forward(Buffer.from(body))
      } catch (e) {
        log("create body not JSON, forwarding as-is:", e.message)
        forward(Buffer.concat(chunks))
      }
    })
  } else {
    forward(undefined)
  }
})

// Hijacked connections (attach / exec start with Upgrade: tcp).
server.on("upgrade", (req, socket, head) => {
  log("upgrade", req.method, req.url)
  const up = net.connect(upstream, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`)
    up.write(lines.join("\r\n") + "\r\n\r\n")
    if (head.length) up.write(head)
    socket.pipe(up)
    up.pipe(socket)
  })
  up.on("error", (e) => { log("upgrade upstream error", e.message); socket.destroy() })
  socket.on("error", () => up.destroy())
})

try { fs.unlinkSync(listen) } catch {}
server.listen(listen, () => log(`docker api proxy ${listen} -> ${upstream}`))
