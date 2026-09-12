import { DatabaseSync } from "node:sqlite"

// Local SQLite contract probe. This is not the runner's Durable Object store.
export function openJournal(path) {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, active INTEGER NOT NULL, checkpoint TEXT);
    INSERT OR IGNORE INTO workspace VALUES (1,1,1,NULL);
    CREATE TABLE IF NOT EXISTS operation (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT);`)
  const workspace = () => db.prepare("SELECT * FROM workspace WHERE id=1").get()
  function transaction(body) {
    db.exec("BEGIN IMMEDIATE")
    try {
      const result = body()
      db.exec("COMMIT")
      return result
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
  function current(generation) {
    const row = workspace()
    if (!row.active || row.generation !== generation) throw new Error("workspace generation fenced")
    return row
  }
  const operation = (id) => db.prepare("SELECT * FROM operation WHERE id=?").get(id)
  return {
    close: () => db.close(),
    workspace,
    operation,
    begin: (id, generation, payload) =>
      transaction(() => {
        current(generation)
        const previous = operation(id)
        if (previous) {
          if (previous.payload !== payload || previous.generation !== generation)
            throw new Error("operation identity conflict")
          return previous
        }
        db.prepare("INSERT INTO operation VALUES (?,?,?,'uncertain',NULL)").run(
          id,
          generation,
          payload,
        )
        return operation(id)
      }),
    commit: (id, generation, checkpoint, result) =>
      transaction(() => {
        current(generation)
        const previous = operation(id)
        if (!previous || previous.generation !== generation)
          throw new Error("operation not admitted")
        if (previous.state === "complete") {
          if (previous.result !== JSON.stringify(result))
            throw new Error("completion identity conflict")
          return previous
        }
        db.prepare("UPDATE workspace SET checkpoint=? WHERE id=1").run(JSON.stringify(checkpoint))
        db.prepare("UPDATE operation SET state='complete', result=? WHERE id=?").run(
          JSON.stringify(result),
          id,
        )
        return operation(id)
      }),
    disconnect: () =>
      transaction(() => {
        db.prepare(
          "UPDATE workspace SET active=0, generation=generation+1, checkpoint=NULL WHERE id=1",
        ).run()
        db.prepare("DELETE FROM operation").run()
      }),
  }
}
