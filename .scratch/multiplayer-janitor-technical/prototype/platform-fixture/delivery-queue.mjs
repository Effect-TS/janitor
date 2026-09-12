import { DatabaseSync } from "node:sqlite"
export function parts(text, maxBytes = 3900) {
  const out = []
  let part = ""
  for (const point of text) {
    if (Buffer.byteLength(part + point) > maxBytes) {
      out.push(part)
      part = ""
    }
    part += point
  }
  if (part) out.push(part)
  return out
}
export class DeliveryQueue {
  constructor(path) {
    this.db = new DatabaseSync(path)
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS channel(id TEXT PRIMARY KEY,available INTEGER NOT NULL,next_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS item(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,session TEXT,channel TEXT,turn TEXT,kind TEXT,payload TEXT,state TEXT NOT NULL DEFAULT 'pending')`,
    )
  }
  add(id, session, channel, turn, kind, payload) {
    if (
      kind === "progress" &&
      this.db
        .prepare("SELECT 1 FROM item WHERE session=? AND turn=? AND kind='terminal'")
        .get(session, turn)
    )
      return
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("INSERT OR IGNORE INTO channel VALUES(?,1,0)").run(channel)
      if (kind === "progress" || kind === "terminal")
        this.db
          .prepare(
            "DELETE FROM item WHERE session=? AND turn=? AND kind='progress' AND state='pending'",
          )
          .run(session, turn)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO item(id,session,channel,turn,kind,payload) VALUES(?,?,?,?,?,?)",
        )
        .run(id, session, channel, turn, kind, payload)
      this.db.exec("COMMIT")
    } catch (e) {
      this.db.exec("ROLLBACK")
      throw e
    }
  }
  access(channel, available) {
    this.db.prepare("UPDATE channel SET available=? WHERE id=?").run(Number(available), channel)
  }
  next(now) {
    return this.db
      .prepare(
        "SELECT i.* FROM item i JOIN channel c ON c.id=i.channel WHERE i.state='pending' AND c.available=1 AND c.next_at<=? AND NOT EXISTS(SELECT 1 FROM item p WHERE p.session=i.session AND p.seq<i.seq AND p.state!='sent') ORDER BY i.seq LIMIT 1",
      )
      .get(now)
  }
  sent(id, now) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db
        .prepare(
          "UPDATE channel SET next_at=MAX(next_at,?) WHERE id=(SELECT channel FROM item WHERE id=?)",
        )
        .run(now + 1000, id)
      this.db.prepare("UPDATE item SET state='sent' WHERE id=?").run(id)
      this.db.exec("COMMIT")
    } catch (e) {
      this.db.exec("ROLLBACK")
      throw e
    }
  }
  throttle(channel, now, retrySeconds) {
    if (!Number.isFinite(retrySeconds) || retrySeconds < 0) throw new Error("Invalid Retry-After")
    this.db
      .prepare("UPDATE channel SET next_at=MAX(next_at,?) WHERE id=?")
      .run(now + Math.ceil(retrySeconds * 1000), channel)
  }
  uncertain(id) {
    this.db.prepare("UPDATE item SET state='uncertain' WHERE id=?").run(id)
  }
  close() {
    this.db.close()
  }
}
