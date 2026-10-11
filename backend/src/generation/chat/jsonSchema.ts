import { ZodFirstPartyTypeKind, type ZodTypeAny } from "zod";
import { REPLY_SCHEMAS, type ReplySchemaName } from "../replySchemas";

/**
 * zod -> JSON Schema for grammar-constrained output (GV-02,
 * docs/roadmap/generation-v2.md; covers R1-18).
 *
 * A local model served by SGLang (xgrammar) or llama.cpp can be held to a
 * JSON Schema while it decodes, so a reply cannot come back as broken JSON
 * or with a field missing. The reply schemas are zod (replySchemas.ts), and
 * zod ^3.23 ships no converter; rather than add a dependency, this converts
 * EXACTLY the subset the reply schemas use:
 *
 *   object, array, string, number, boolean, enum, optional (as an object
 *   property), nullable, and length bounds (.min/.max/.length on a string
 *   or an array).
 *
 * The rules:
 *   - an optional property is left out of `required`;
 *   - nullable becomes `type: [T, "null"]` (and `null` joins an enum);
 *   - every object gets `additionalProperties: false`;
 *   - string bounds become minLength/maxLength, array bounds minItems/maxItems.
 *
 * Anything else (union, effects such as transform or refine, record,
 * default, a string format check, a number bound, an optional outside an
 * object) throws `UnsupportedZodError` naming the path, because a schema the
 * grammar cannot express exactly would let the grammar and the parser
 * disagree about what a valid reply is.
 *
 * Inert until a provider sends `responseFormatFor(...)` as response_format
 * (W2-04); nothing on the default path imports this module.
 */

export type JsonSchemaType = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonSchema {
  type: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  enum?: Array<string | null>;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}

/** A zod construct the converter does not translate, with the path to it
 * (`$` is the reply's root, `.name` a property, `[]` an array's items). */
export class UnsupportedZodError extends Error {
  constructor(
    readonly path: string,
    readonly construct: string
  ) {
    super(`zodToJsonSchema: ${construct} at ${path} has no JSON Schema translation here; reply schemas may use only object, array, string, number, boolean, enum, optional, nullable and length bounds`);
    this.name = "UnsupportedZodError";
  }
}

/* zod's own internal definition shape, read through a narrow view so the
   converter does not depend on private class names beyond `typeName`. */
interface ZodDefView {
  typeName?: string;
  checks?: Array<{ kind: string; value?: number }>;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  exactLength?: { value: number } | null;
  type?: ZodTypeAny;
  innerType?: ZodTypeAny;
  values?: readonly string[];
  effect?: { type?: string };
  unknownKeys?: string;
  catchall?: ZodTypeAny;
}

function defOf(schema: ZodTypeAny): ZodDefView {
  return schema._def as ZodDefView;
}

function kindOf(schema: ZodTypeAny): string {
  return defOf(schema).typeName ?? "an unknown zod type";
}

function describeUnsupported(schema: ZodTypeAny): string {
  const def = defOf(schema);
  if (def.typeName === ZodFirstPartyTypeKind.ZodEffects && def.effect?.type) return `ZodEffects (${def.effect.type})`;
  return kindOf(schema);
}

function stringBounds(schema: ZodTypeAny, path: string): Pick<JsonSchema, "minLength" | "maxLength"> {
  const out: Pick<JsonSchema, "minLength" | "maxLength"> = {};
  for (const check of defOf(schema).checks ?? []) {
    if (check.kind === "min" && typeof check.value === "number") out.minLength = check.value;
    else if (check.kind === "max" && typeof check.value === "number") out.maxLength = check.value;
    else if (check.kind === "length" && typeof check.value === "number") {
      out.minLength = check.value;
      out.maxLength = check.value;
    } else throw new UnsupportedZodError(path, `ZodString check "${check.kind}"`);
  }
  return out;
}

function arrayBounds(schema: ZodTypeAny): Pick<JsonSchema, "minItems" | "maxItems"> {
  const def = defOf(schema);
  const out: Pick<JsonSchema, "minItems" | "maxItems"> = {};
  if (def.exactLength) {
    out.minItems = def.exactLength.value;
    out.maxItems = def.exactLength.value;
  }
  if (def.minLength) out.minItems = def.minLength.value;
  if (def.maxLength) out.maxItems = def.maxLength.value;
  return out;
}

function convertObject(schema: ZodTypeAny, path: string): JsonSchema {
  const def = defOf(schema);
  if (def.catchall && kindOf(def.catchall) !== ZodFirstPartyTypeKind.ZodNever) {
    throw new UnsupportedZodError(path, "ZodObject catchall");
  }
  if (def.unknownKeys === "passthrough") throw new UnsupportedZodError(path, "ZodObject passthrough");
  const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const childPath = `${path}.${key}`;
    if (kindOf(child) === ZodFirstPartyTypeKind.ZodOptional) {
      properties[key] = convert(defOf(child).innerType as ZodTypeAny, childPath);
    } else {
      properties[key] = convert(child, childPath);
      required.push(key);
    }
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function convertNullable(schema: ZodTypeAny, path: string): JsonSchema {
  const inner = convert(defOf(schema).innerType as ZodTypeAny, path);
  if (Array.isArray(inner.type)) throw new UnsupportedZodError(path, "ZodNullable of a nullable");
  const out: JsonSchema = { ...inner, type: [inner.type, "null"] };
  if (inner.enum) out.enum = [...inner.enum, null];
  return out;
}

function convert(schema: ZodTypeAny, path: string): JsonSchema {
  switch (kindOf(schema)) {
    case ZodFirstPartyTypeKind.ZodObject:
      return convertObject(schema, path);
    case ZodFirstPartyTypeKind.ZodArray:
      return { type: "array", items: convert(defOf(schema).type as ZodTypeAny, `${path}[]`), ...arrayBounds(schema) };
    case ZodFirstPartyTypeKind.ZodString:
      return { type: "string", ...stringBounds(schema, path) };
    case ZodFirstPartyTypeKind.ZodNumber: {
      const checks = defOf(schema).checks ?? [];
      if (checks.length > 0) throw new UnsupportedZodError(path, `ZodNumber check "${checks[0]?.kind}"`);
      return { type: "number" };
    }
    case ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };
    case ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: [...(defOf(schema).values ?? [])] };
    case ZodFirstPartyTypeKind.ZodNullable:
      return convertNullable(schema, path);
    case ZodFirstPartyTypeKind.ZodOptional:
      /* Only an object property can be absent; JSON has no "undefined"
         array item or root, so an optional anywhere else is a schema the
         grammar would read differently from zod. */
      throw new UnsupportedZodError(path, "ZodOptional outside an object property");
    default:
      throw new UnsupportedZodError(path, describeUnsupported(schema));
  }
}

/** The JSON Schema for a reply schema. Throws `UnsupportedZodError` for a
 * construct outside the supported subset (see the module comment). */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  return convert(schema, "$");
}

export interface JsonSchemaResponseFormat {
  readonly type: "json_schema";
  readonly name: ReplySchemaName;
  readonly schema: JsonSchema;
  readonly strict: true;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const responseFormatCache = new Map<ReplySchemaName, JsonSchemaResponseFormat>();

/** The json_schema response_format for one reply, converted once and
 * cached; frozen, because every caller shares the one object. Prose fields
 * stay free strings: the grammar holds the shape, not the wording. */
export function responseFormatFor(name: ReplySchemaName): JsonSchemaResponseFormat {
  const cached = responseFormatCache.get(name);
  if (cached) return cached;
  const schema = REPLY_SCHEMAS[name];
  if (!schema) throw new Error(`responseFormatFor: no reply schema named "${String(name)}"`);
  const format = deepFreeze<JsonSchemaResponseFormat>({ type: "json_schema", name, schema: zodToJsonSchema(schema), strict: true });
  responseFormatCache.set(name, format);
  return format;
}
