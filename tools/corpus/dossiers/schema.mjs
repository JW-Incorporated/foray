/* The dossier file and manifest schemas (GV-30, W3-19).
 *
 * DOSSIER_SCHEMA is the contract the backend's DossierExternalResearcher
 * (GV-69, W3-21) mirrors in zod and is tested against through a committed
 * fixture. It is plain JSON Schema (draft 2020-12 keywords), so the backend
 * can copy it without importing this package.
 *
 * `validate` interprets exactly the keywords these two schemas use (type,
 * const, enum, required, properties, additionalProperties, items, pattern,
 * minLength, maxLength, minimum, format date-time) with no dependency; it
 * returns a list of "path: problem" strings, empty when valid. It is a
 * schema INTERPRETER, not a second copy of the rules, so the schema stays the
 * single source of truth.
 */

import { MAX_PASSAGE_CHARS } from "./passages.mjs";

export const DOSSIER_VERSION = 1;
export const BUILDERS = ["code", "qwen-select"];

const SHA256 = { type: "string", pattern: "^[0-9a-f]{64}$" };
const DATE_TIME = { type: "string", format: "date-time" };
const NODE_ID = { type: "string", minLength: 1, pattern: "^[a-z0-9][a-z0-9/-]*$" };
const SOURCE_ID = { type: "string", pattern: "^[0-9a-f]{12}$" };

const MISSING = {
  type: "object",
  required: ["url", "status", "reason"],
  additionalProperties: false,
  properties: {
    url: { type: "string", minLength: 1 },
    /* HTTP status, -1 for a robots.txt refusal, 0 for a network failure or
       an unusable page (no passages, unsupported content). */
    status: { type: "integer" },
    reason: { type: "string", minLength: 1 },
  },
};

export const DOSSIER_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "foray:dossier/1",
  title: "Foray topic dossier",
  type: "object",
  required: ["version", "node_id", "label", "built_at", "builder", "sources", "passages", "missing"],
  additionalProperties: false,
  properties: {
    version: { const: DOSSIER_VERSION },
    node_id: NODE_ID,
    label: { type: "string", minLength: 1 },
    built_at: DATE_TIME,
    builder: { enum: BUILDERS },
    sources: {
      type: "array",
      items: {
        type: "object",
        required: ["sourceId", "url", "publication", "title", "retrievedAt", "sha256", "license"],
        additionalProperties: false,
        properties: {
          sourceId: SOURCE_ID,
          url: { type: "string", pattern: "^https://" },
          publication: { type: "string", minLength: 1 },
          title: { type: "string" },
          retrievedAt: DATE_TIME,
          /* sha256 of the RAW fetched bytes, before extraction. */
          sha256: SHA256,
          license: { type: "string", minLength: 1 },
        },
      },
    },
    passages: {
      type: "array",
      items: {
        type: "object",
        required: ["docId", "sourceId", "text", "offset"],
        additionalProperties: false,
        properties: {
          docId: { type: "string", pattern: "^dossier:[a-z0-9/-]+:[0-9a-f]{12}:[0-9]+$" },
          sourceId: SOURCE_ID,
          text: { type: "string", minLength: 1, maxLength: MAX_PASSAGE_CHARS },
          /* Character offset of `text` in its source's extracted text. */
          offset: { type: "integer", minimum: 0 },
          /* Set only by the Qwen selection pass (GV-65). */
          contested: { type: "boolean" },
        },
      },
    },
    missing: { type: "array", items: MISSING },
  },
};

export const MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "foray:dossier-manifest/1",
  title: "Foray dossier manifest",
  type: "object",
  required: ["version", "updated_at", "nodes"],
  additionalProperties: false,
  properties: {
    version: { const: DOSSIER_VERSION },
    updated_at: DATE_TIME,
    nodes: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["label", "file", "sha256", "passages", "sources", "built_at", "missing"],
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          /* null when the node has no passage (every seed missing). */
          file: { type: ["string", "null"] },
          sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
          passages: { type: "integer", minimum: 0 },
          sources: { type: "integer", minimum: 0 },
          built_at: DATE_TIME,
          missing: { type: "array", items: MISSING },
        },
      },
    },
  },
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const typeMatches = (want, got) => want === got || (want === "number" && got === "integer");

/** Validates `value` against `schema`; returns problems ([] when valid). */
export function validate(schema, value, at = "$") {
  const errs = [];
  if ("const" in schema && value !== schema.const) errs.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: not one of ${schema.enum.join(", ")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, typeOf(value)))) {
      errs.push(`${at}: expected ${types.join("|")}, got ${typeOf(value)}`);
      return errs;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && !(ISO.test(value) && !Number.isNaN(Date.parse(value)))) errs.push(`${at}: not a date-time`);
  }
  if (typeof value === "number" && schema.minimum != null && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${at}: missing ${k}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errs.push(...validate(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errs.push(...validate(schema.additionalProperties, v, `${at}.${k}`));
      }
    }
  }
  return errs;
}

export const validateDossier = (d) => validate(DOSSIER_SCHEMA, d);
export const validateManifest = (m) => validate(MANIFEST_SCHEMA, m);
