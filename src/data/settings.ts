import type { Db } from './db.ts';

/** Server-wide switches and job bookkeeping, stored so they change without a deploy. */
export class SettingsRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async get<T>(key: string): Promise<T | null> {
    const [row] = await this.db.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
    return row ? row.value : null;
  }

  async set(key: string, value: unknown, now: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), now],
    );
  }

  async isHoliday(day: string): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM market_holidays WHERE day = $1', [day])).length > 0;
  }

  async holidays(): Promise<{ day: string; name: string }[]> {
    return this.db.query('SELECT day, name FROM market_holidays ORDER BY day');
  }

  async addHoliday(day: string, name: string): Promise<void> {
    await this.db.query('INSERT INTO market_holidays (day, name) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET name = excluded.name', [day, name]);
  }

  async jobState<T>(name: string): Promise<T | null> {
    const [row] = await this.db.query<{ value: T }>('SELECT value FROM job_state WHERE name = $1', [name]);
    return row ? row.value : null;
  }

  async setJobState(name: string, value: unknown, now: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO job_state (name, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [name, JSON.stringify(value), now],
    );
  }
}
