import { createClient } from '@libsql/client';

/**
 * libsql-backed PlaybackStore implementing the same interface the Vercel
 * serverless deployment expects (load/compareAndSet over whole JSON state
 * blobs). The playback sync + identity registry both live in this one table;
 * each spaceKey maps to a single JSON document that is swapped via an
 * optimistic compare-and-set. A plain single-statement UPDATE ... WHERE
 * state = :version gives CAS semantics without holding a transaction, which
 * keeps SQLite free of SQLITE_BUSY on a local single-writer database. The
 * caller already retries on a failed CAS (MAX_CAS_ATTEMPTS).
 */
export function createLibsqlPlaybackStore(url, authToken) {
  const client = createClient({ url, authToken });

  async function ready() {
    await client.execute(`CREATE TABLE IF NOT EXISTS playback_spaces (
      key TEXT PRIMARY KEY,
      state TEXT NOT NULL
    )`);
    // Reduce lock contention on a local single-writer database.
    try {
      await client.execute(`PRAGMA busy_timeout = 5000`);
    } catch (err) {
      console.warn('playback-store: unable to set busy_timeout', err && err.message ? err.message : err);
    }
  }

  async function reset() {
    await client.execute(`DROP TABLE IF EXISTS playback_spaces`);
    await ready();
  }

  async function load(spaceKey) {
    const { rows } = await client.execute({
      sql: 'SELECT state FROM playback_spaces WHERE key = ?',
      args: [spaceKey]
    });
    if (!rows.length) return { version: null, state: null };
    const raw = rows[0].state;
    return { version: raw, state: raw ? JSON.parse(raw) : null };
  }

  async function compareAndSet(spaceKey, version, state) {
    const raw = JSON.stringify(state);
    try {
      if (version == null) {
        const r = await client.execute({
          sql: 'INSERT OR IGNORE INTO playback_spaces (key, state) VALUES (?, ?)',
          args: [spaceKey, raw]
        });
        return r.rowsAffected === 1;
      }
      const r = await client.execute({
        sql: 'UPDATE playback_spaces SET state = ? WHERE key = ? AND state = ?',
        args: [raw, spaceKey, version]
      });
      return r.rowsAffected === 1;
    } catch (err) {
      console.error('compareAndSet failed', err && err.message ? err.message : err);
      return false;
    }
  }

  return {
    persistent: true,
    isConfigured: () => true,
    load,
    compareAndSet,
    ready,
    reset
  };
}
