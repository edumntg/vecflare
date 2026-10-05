import { fail } from "./errors";
import type { Filter, FilterOp } from "./types";

export interface CompiledFilter {
  sql: string;
  params: unknown[];
}

const FIELD_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MAX_DEPTH = 16;
const MAX_IN = 10_000;

// Durable Object SQLite allows few bound parameters per statement, so lists travel as one JSON array.
function jsonList(values: unknown[], field: string, params: unknown[]): string {
  params.push(JSON.stringify(values.map((v) => scalar(v, field))));
  return "(SELECT value FROM json_each(?))";
}

/** Attributes live as a JSON text column, so every field access is a json_extract. */
function fieldExpr(field: string): string {
  if (field === "id") return "id";
  if (!FIELD_RE.test(field)) fail(400, `invalid filter field "${field}"`);
  return `json_extract(attrs, '$."${field}"')`;
}

function scalar(v: unknown, field: string): string | number | null {
  if (v === null) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return fail(400, `filter value for "${field}" must be a string, number, boolean or null`);
}

export function compileFilter(filter: Filter): CompiledFilter {
  const params: unknown[] = [];
  const sql = compile(filter, params, 0);
  return { sql, params };
}

function compile(f: Filter, params: unknown[], depth: number): string {
  if (depth > MAX_DEPTH) fail(400, "filter nested too deeply");
  if (!Array.isArray(f) || f.length < 2) fail(400, "filter must be a [field, op, value] or [And|Or|Not, ...] array");

  if (f[0] === "And" || f[0] === "Or") {
    const parts = f[1];
    if (!Array.isArray(parts) || parts.length === 0) fail(400, `${f[0]} needs a non-empty array of filters`);
    const joined = parts.map((p) => compile(p as Filter, params, depth + 1)).join(f[0] === "And" ? " AND " : " OR ");
    return `(${joined})`;
  }
  if (f[0] === "Not") {
    return `(NOT ${compile(f[1] as Filter, params, depth + 1)})`;
  }
  if (f.length !== 3) fail(400, "filter must be a [field, op, value] array");
  const [field, op, value] = f as [string, FilterOp, unknown];
  const col = fieldExpr(field);

  switch (op) {
    case "Eq":
      if (value === null) return `${col} IS NULL`;
      params.push(scalar(value, field));
      return `${col} = ?`;
    case "NotEq":
      if (value === null) return `${col} IS NOT NULL`;
      params.push(scalar(value, field));
      return `(${col} IS NULL OR ${col} != ?)`;
    case "Lt":
    case "Lte":
    case "Gt":
    case "Gte": {
      const sym = { Lt: "<", Lte: "<=", Gt: ">", Gte: ">=" }[op];
      params.push(scalar(value, field));
      return `${col} ${sym} ?`;
    }
    case "In":
    case "NotIn": {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN) fail(400, `${op} needs an array of 1 to ${MAX_IN} values`);
      const list = jsonList(value, field, params);
      return op === "In" ? `${col} IN ${list}` : `(${col} IS NULL OR ${col} NOT IN ${list})`;
    }
    case "Glob":
    case "NotGlob":
      if (typeof value !== "string") fail(400, `${op} needs a string pattern`);
      params.push(value);
      return op === "Glob" ? `${col} GLOB ?` : `(${col} IS NULL OR ${col} NOT GLOB ?)`;
    case "Contains": {
      // Array attribute contains a scalar.
      if (field === "id") fail(400, "Contains is not supported on id");
      params.push(scalar(value, field));
      return `EXISTS (SELECT 1 FROM json_each(attrs, '$."${field}"') WHERE value = ?)`;
    }
    case "ContainsAny": {
      if (field === "id") fail(400, "ContainsAny is not supported on id");
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN) fail(400, `ContainsAny needs an array of 1 to ${MAX_IN} values`);
      const list = jsonList(value, field, params);
      return `EXISTS (SELECT 1 FROM json_each(attrs, '$."${field}"') WHERE value IN ${list})`;
    }
    default:
      return fail(400, `unknown filter op "${String(op)}"`);
  }
}
