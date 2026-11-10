import type { SQLInputValue } from "node:sqlite";
import type { Database } from "./db.js";

const fields = "id,chat_jid,sender,content,timestamp,is_from_me";
const phone = (jid: string) => jid.split("@", 1)[0];
type Row = Record<string, unknown>;
type Message = Row & { id: string; chat_jid: string; timestamp: number };

function format(row: Row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value !== null && (key === "timestamp" || key === "last_message_time")) {
      return [key, new Date(Number(value)).toISOString()];
    }
    if (value !== null && (key === "is_from_me" || key === "last_is_from_me")) return [key, Boolean(value)];
    return [key, value];
  }));
}

function time(value: string | null | undefined) {
  if (value == null) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Use a valid ISO date or timestamp");
  return ms;
}

export class Queries {
  constructor(private readonly db: Database) {}

  async chats({ query, limit, page, include_last_message: preview, sort_by, exact }: {
    query?: string | null;
    limit: number;
    page: number;
    include_last_message: boolean;
    sort_by?: string;
    exact?: string;
  }) {
    const last = preview ? `m.content AS last_message,m.sender AS last_sender,m.is_from_me AS last_is_from_me`
      : "NULL AS last_message,NULL AS last_sender,NULL AS last_is_from_me";
    const join = preview ? `LEFT JOIN messages m ON m.chat_jid=c.jid AND m.id=
      (SELECT id FROM messages WHERE chat_jid=c.jid ORDER BY timestamp DESC,id DESC LIMIT 1)` : "";
    const search = exact != null ? "c.jid=?" : query != null ? "(instr(fold(c.name),fold(?))>0 OR instr(fold(c.jid),fold(?))>0)" : "1";
    const args: SQLInputValue[] = exact != null ? [exact] : query != null ? [query, query] : [];
    const order = sort_by == null || sort_by === "last_active" ? "c.last_message_time DESC" : "c.name";
    const rows = await this.db.all<Row>(`SELECT c.jid,c.name,c.last_message_time,${last} FROM chats c ${join}
      WHERE ${search} ORDER BY ${order},c.jid LIMIT ? OFFSET ?`, ...args, limit, page * limit);
    return rows.map(format);
  }

  async searchContacts(query: string) {
    return this.db.all(`SELECT jid,jid_user(jid) AS phone_number,name FROM (
        SELECT jid,coalesce(nullif(name,''),push_name,'') AS name FROM contacts
        UNION SELECT jid,name FROM chats WHERE jid NOT LIKE '%@g.us'
      ) WHERE instr(fold(name),fold(?))>0 OR instr(fold(jid),fold(?))>0
      ORDER BY name,jid LIMIT 50`, query, query);
  }

  async messages(input: {
    after?: string | null;
    before?: string | null;
    sender_phone_number?: string | null;
    chat_jid?: string | null;
    query?: string | null;
    limit: number;
    page: number;
    include_context: boolean;
    context_before: number;
    context_after: number;
  }) {
    const conditions: string[] = [];
    const args: SQLInputValue[] = [];
    const after = time(input.after);
    const before = time(input.before);
    if (after !== null) { conditions.push("timestamp>?"); args.push(after); }
    if (before !== null) { conditions.push("timestamp<?"); args.push(before); }
    if (input.sender_phone_number != null) {
      conditions.push("(sender=? OR jid_user(sender)=?)");
      args.push(input.sender_phone_number, input.sender_phone_number);
    }
    if (input.chat_jid != null) { conditions.push("chat_jid=?"); args.push(input.chat_jid); }
    if (input.query != null) { conditions.push("instr(fold(content),fold(?))>0"); args.push(input.query); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.db.all<Message>(`SELECT ${fields},media_type,filename FROM messages ${where}
      ORDER BY timestamp DESC,id DESC,chat_jid LIMIT ? OFFSET ?`, ...args, input.limit, input.page * input.limit);
    return Promise.all(rows.map(async (row) => {
      const result = format(row);
      if (input.include_context) result.context = await this.surrounding(row, input.context_before, input.context_after);
      return result;
    }));
  }

  async contactChats(jid: string, limit: number, page: number) {
    const rows = await this.db.all<Row>(`SELECT c.jid,c.name,c.last_message_time FROM chats c
      WHERE c.jid=? OR EXISTS(SELECT 1 FROM messages m WHERE m.chat_jid=c.jid AND (m.sender=? OR jid_user(m.sender)=?))
      ORDER BY c.last_message_time DESC,c.jid LIMIT ? OFFSET ?`, jid, jid, phone(jid), limit, page * limit);
    return rows.map(format);
  }

  async lastInteraction(jid: string) {
    const row = await this.db.get<Row>(`SELECT ${fields} FROM messages
      WHERE chat_jid=? OR sender=? OR jid_user(sender)=? ORDER BY timestamp DESC,id DESC,chat_jid LIMIT 1`,
      jid, jid, phone(jid));
    return row ? format(row) : {};
  }

  async context(id: string, before: number, after: number, jid?: string | null) {
    const rows = await this.db.all<Message>(`SELECT ${fields} FROM messages
      WHERE id=? AND (? IS NULL OR chat_jid=?) LIMIT 2`, id, jid ?? null, jid ?? null);
    if (rows.length !== 1) return { status: "not_found_or_ambiguous" };
    return this.surrounding(rows[0], before, after);
  }

  private async surrounding(row: Message, before: number, after: number) {
    const [previous, following] = await Promise.all([
      this.db.all<Row>(`SELECT ${fields} FROM messages WHERE chat_jid=? AND (timestamp,id)<(?,?)
        ORDER BY timestamp DESC,id DESC LIMIT ?`, row.chat_jid, row.timestamp, row.id, before),
      this.db.all<Row>(`SELECT ${fields} FROM messages WHERE chat_jid=? AND (timestamp,id)>(?,?)
        ORDER BY timestamp,id LIMIT ?`, row.chat_jid, row.timestamp, row.id, after),
    ]);
    const { id, chat_jid, sender, content, timestamp, is_from_me } = row;
    return {
      message: format({ id, chat_jid, sender, content, timestamp, is_from_me }),
      before: previous.reverse().map(format),
      after: following.map(format),
    };
  }
}
