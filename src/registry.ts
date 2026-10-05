import { DurableObject } from "cloudflare:workers";

/** Single instance that remembers which namespaces exist, so they can be listed. */
export class Registry extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS namespaces (name TEXT PRIMARY KEY, created INTEGER NOT NULL)");
  }

  async register(name: string): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO namespaces (name, created) VALUES (?, ?)", name, Date.now());
  }

  async unregister(name: string): Promise<void> {
    this.sql.exec("DELETE FROM namespaces WHERE name = ?", name);
  }

  async list(): Promise<{ name: string; created_at: number }[]> {
    return this.sql
      .exec<{ name: string; created: number }>("SELECT name, created FROM namespaces ORDER BY name")
      .toArray()
      .map((r) => ({ name: r.name, created_at: r.created }));
  }
}
