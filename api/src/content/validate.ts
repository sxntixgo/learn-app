import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// Named (not default) import: this repo's tsconfig has esModuleInterop off,
// and ajv's CJS build resolves a default import to the whole module
// namespace rather than the Ajv2020 class under that configuration. The
// named export sidesteps the interop ambiguity.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';

// schemas/*.json live at the repo root (design §6.2: "that schema is the
// real contract between content repos and the platform, and nothing in it
// is JavaScript-shaped — which is what makes a Go importer possible"), not
// inside api/, so a future non-Node importer can read them without any
// dependency on this package. Resolved with fs + import.meta.url rather
// than a JSON module import so tsc's `include: ["src"]` rootDir never has
// to reason about a path outside the package (see api/tsconfig.json).
const SCHEMAS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../schemas');

function loadSchema(filename: string): object {
  const raw = readFileSync(path.join(SCHEMAS_DIR, filename), 'utf8');
  return JSON.parse(raw) as object;
}

// strictRequired is disabled because schemas/blocks.schema.json's `annotation`
// def uses `oneOf: [{ required: ["line"] }, { required: ["lines"] }]` to
// express "exactly one of line/lines" — each oneOf branch legitimately
// requires a property it doesn't itself declare under `properties` (that
// lives one level up, on `annotation` itself), which ajv's strict mode
// otherwise flags as likely a mistake.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, discriminator: true });

const validateCourseSchema = ajv.compile(loadSchema('course.schema.json'));
const validateBlocksSchema = ajv.compile(loadSchema('blocks.schema.json'));

export interface ValidationError {
  /** JSON Pointer (RFC 6901) to the offending location, e.g. "/tracks/0/hue". */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function toResult(valid: boolean, ajvErrors: ErrorObject[] | null | undefined): ValidationResult {
  if (valid) {
    return { valid: true, errors: [] };
  }
  const errors: ValidationError[] = (ajvErrors ?? []).map((e) => ({
    path: e.instancePath === '' ? '/' : e.instancePath,
    message: e.message ?? 'is invalid',
  }));
  return { valid: false, errors };
}

/** Validates a parsed `course.yaml` manifest object against schemas/course.schema.json. */
export function validateCourseManifest(obj: unknown): ValidationResult {
  const valid = validateCourseSchema(obj);
  return toResult(valid, validateCourseSchema.errors);
}

/** Validates a lesson's block array against schemas/blocks.schema.json. */
export function validateBlocks(arr: unknown): ValidationResult {
  const valid = validateBlocksSchema(arr);
  return toResult(valid, validateBlocksSchema.errors);
}
