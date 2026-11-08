// Postgres undo, v0: every write statement is journaled and flagged.
// Next: wrap writes so yard captures the affected rows first
//   UPDATE/DELETE -> SELECT the matching rows into the snapshot, restore them on undo
//   INSERT        -> add RETURNING primary keys, delete them on undo
import type { Handler } from "./types.js";

const WRITE = /^\s*(insert|update|delete|alter|drop|truncate|create)\b/i;

export const isWriteSql = (sql: unknown) => typeof sql === "string" && WRITE.test(sql);

export const postgresHandler: Handler = {
  irreversible: "Postgres row-level undo is not built yet; this write is journaled only.",
};
