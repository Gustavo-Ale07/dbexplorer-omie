/**
 * Converts raw Omie values into SQL-friendly values and back.
 * Dates: Omie dd/mm/aaaa ⇄ ISO YYYY-MM-DD. Flags stay as 'S' / 'N' strings.
 */
import { AppError } from '@dbx/shared';
import { readPath } from './registry';
import type { ColumnDef, ColumnType, RawRecord, ResourceDef } from './registry';

export type Value = string | number | boolean | null;
export type Row = Value[];

const OMIE_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function omieDateToIso(s: string): string | null {
  const trimmed = s.trim();
  if (trimmed === '') return null;
  const m = OMIE_DATE.exec(trimmed);
  if (!m) return trimmed;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Accepts ISO (YYYY-MM-DD) or dd/mm/aaaa; returns the Omie wire format. */
export function toOmieDate(value: unknown, column: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  let y: number, mo: number, d: number;
  const iso = ISO_DATE.exec(s);
  const br = OMIE_DATE.exec(s);
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (br) [y, mo, d] = [Number(br[3]), Number(br[2]), Number(br[1])];
  else
    throw new AppError(
      'VALIDATION_ERROR',
      `Column ${column} expects a date as 'YYYY-MM-DD' or 'dd/mm/aaaa'.`,
    );
  if (!validDate(y, mo, d))
    throw new AppError('VALIDATION_ERROR', `Invalid date for ${column}: ${s}.`);
  return `${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y}`;
}

export function normalizeValue(raw: unknown, type: ColumnType): Value {
  if (raw === undefined || raw === null) return null;
  switch (type) {
    case 'integer':
    case 'number': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
      if (typeof raw === 'string') {
        const t = raw.trim();
        if (t === '') return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : t;
      }
      return typeof raw === 'boolean' ? (raw ? 1 : 0) : null;
    }
    case 'date':
      return typeof raw === 'string' ? omieDateToIso(raw) : null;
    case 'flag':
    case 'string': {
      if (typeof raw === 'string') return type === 'flag' && raw.trim() === '' ? null : raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
      return JSON.stringify(raw);
    }
  }
}

export function readColumn(raw: RawRecord, column: ColumnDef): Value {
  const v = column.read ? column.read(raw) : readPath(raw, column.path);
  return normalizeValue(v, column.type);
}

/** One normalized row (in resource column order) for a raw record. */
export function toRow(resource: ResourceDef, raw: RawRecord): Row {
  return resource.columns.map((c) => readColumn(raw, c));
}

/** Validates and converts a SQL value into the wire value for a write. */
export function toWireValue(column: ColumnDef, value: Value): unknown {
  if (value === null) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Column ${column.name} cannot be set to NULL; use an empty string or 0 instead.`,
    );
  }
  switch (column.type) {
    case 'integer':
    case 'number': {
      const n =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : NaN;
      if (!Number.isFinite(n))
        throw new AppError('VALIDATION_ERROR', `Column ${column.name} expects a number.`);
      if (column.type === 'integer' && !Number.isInteger(n)) {
        throw new AppError('VALIDATION_ERROR', `Column ${column.name} expects an integer.`);
      }
      return n;
    }
    case 'date':
      return toOmieDate(value, column.name);
    case 'flag': {
      const s = String(value).toUpperCase();
      if (s !== 'S' && s !== 'N')
        throw new AppError('VALIDATION_ERROR', `Column ${column.name} expects 'S' or 'N'.`);
      return s;
    }
    case 'string': {
      const s = typeof value === 'string' ? value : String(value);
      if (column.maxLength !== undefined && s.length > column.maxLength) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Column ${column.name} accepts at most ${column.maxLength} characters.`,
        );
      }
      return s;
    }
  }
}
