import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// Named (not default) import: this repo's tsconfig has esModuleInterop off,
// and ajv's CJS build resolves a default import to the whole module
// namespace rather than the Ajv2020 class under that configuration. The
// named export sidesteps the interop ambiguity.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

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

// badge.schema.json is ADDED before course.schema.json is compiled, not
// compiled on its own first: course.schema.json's `badges` array `$ref`s it
// by $id (design §9.3 — a badge item has the same shape wherever it is
// declared), and ajv resolves that reference out of its schema registry.
// Without this line, compiling the course schema throws
// "can't resolve reference https://learn-app.example/schemas/badge.schema.json".
const badgeSchema = loadSchema('badge.schema.json');
ajv.addSchema(badgeSchema);

const validateCourseSchema = ajv.compile(loadSchema('course.schema.json'));
const validateBlocksSchema = ajv.compile(loadSchema('blocks.schema.json'));

const validateBadgeSchema = ajv.compile({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $ref: 'https://learn-app.example/schemas/badge.schema.json',
});

// ---------------------------------------------------------------------------
// The criteria sub-schema, compiled ONE BRANCH AT A TIME rather than as the
// whole `oneOf`.
//
// Validating `{type: "streak_days", dayz: 7}` against the eight-branch oneOf
// produces 23 ajv errors — one set per branch that failed, plus "must match
// exactly one schema in oneOf" — none of which says the useful thing
// ("streak_days does not take `dayz`"). Design §8: "every failure names
// file, line, and expectation. Worth over-investing in early."
//
// So `type` is read first and dispatched on: an unknown type gets ONE error
// naming the closed vocabulary (design §9.3 — "adding a ninth type is a
// deliberate platform change", so an unrecognised one is never a near-miss
// worth guessing at), and a known type is checked against ITS OWN branch,
// whose errors are about the fields that type actually has. The branches are
// discovered from the schema file itself, so adding that ninth type means
// editing schemas/badge.schema.json and api/src/progression/criteria.ts —
// never this file.
// ---------------------------------------------------------------------------
interface CriteriaBranch {
  properties?: { type?: { const?: unknown } };
}

const CRITERIA_BRANCHES: ReadonlyArray<{ type: string; index: number }> = (
  (badgeSchema as { $defs?: { criteria?: { oneOf?: CriteriaBranch[] } } }).$defs?.criteria?.oneOf ?? []
).map((branch, index) => ({ type: String(branch.properties?.type?.const), index }));

const validateCriteriaBranch = new Map<string, ValidateFunction>(
  CRITERIA_BRANCHES.map(({ type, index }) => [
    type,
    ajv.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: `https://learn-app.example/schemas/badge.schema.json#/$defs/criteria/oneOf/${index}`,
    }),
  ]),
);

/** The eight type names, read off the schema — never a second hand-kept list. */
export const BADGE_CRITERION_TYPES: readonly string[] = Object.freeze(CRITERIA_BRANCHES.map((b) => b.type));

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

/**
 * Validates one badge definition (design §9.3) against
 * schemas/badge.schema.json — the same contract for a badge declared in a
 * curriculum repo's `course.yaml` and for one created through the admin
 * CRUD, so a badge cannot exist in the database in a shape the exporter
 * could not write back out as valid YAML.
 */
export function validateBadge(obj: unknown): ValidationResult {
  const valid = validateBadgeSchema(obj);
  return toResult(valid, validateBadgeSchema.errors);
}

/**
 * Validates a bare criteria object — THE CLOSED VOCABULARY of design §9.3.
 * A `jsonb` column cannot express "exactly these eight types, each with its
 * own required fields", so every write path (importer and admin route
 * alike) runs a value through here before it reaches `badges.criteria`.
 */
export function validateBadgeCriteria(obj: unknown): ValidationResult {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { valid: false, errors: [{ path: '/', message: 'must be a criteria object' }] };
  }

  const type = (obj as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return { valid: false, errors: [{ path: '/type', message: 'is required and must be a string' }] };
  }

  const validate = validateCriteriaBranch.get(type);
  if (!validate) {
    return {
      valid: false,
      errors: [
        {
          path: '/type',
          message: `"${type}" is not one of the eight badge criteria types: ${BADGE_CRITERION_TYPES.join(', ')}`,
        },
      ],
    };
  }

  return toResult(validate(obj), validate.errors);
}
