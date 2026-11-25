import { workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'

// The snapshot holds a WAL read transaction. The Hub keeps its own writer and event loop.
const db = new Database(workerData.source, { readonly: true, fileMustExist: true })
try {
  db.prepare('VACUUM INTO ?').run(workerData.destination)
} finally {
  db.close()
}
