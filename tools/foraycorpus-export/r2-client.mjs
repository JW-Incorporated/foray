/* R2 S3 client for the corpus sync (PKG-11, G-11; docs/roadmap/corpus.md §3
   "PKG-11 · r2-client.mjs").

   Reads the bucket `foray-transcriptions` that the transcript farm writes in
   foray's own layout. Four pieces, each injectable so the tests need no
   network, no credential and no live bucket:

   - loadR2Credentials({ env, readFile, homedir }): the env names in
     config.mjs R2_ENV first (all three of key id, secret and endpoint set),
     else the credential file named by R2_CREDENTIALS_FILE, else
     ~/.foray/r2-credentials. The file is `key = value` lines (`=` with or
     without spaces, `#` comments and `[section]` lines skipped). Keys are
     lowercased before they are matched against ALIASES, the farm's own table
     (transcript-farm/farm/r2.py `_client_config`, inlined in the spec), so the
     Cloudflare dashboard spelling `Access_Key_ID` and the env-var spelling
     HUMAN-ACTIONS #138 tells the founder to write (`R2_ACCESS_KEY_ID=`) both
     resolve. The bucket defaults to DEFAULT_BUCKET. A miss throws
     R2Error NO_CREDENTIALS naming the sources tried (env names, file path),
     never a value. The returned object keeps the secret non-enumerable and
     its toJSON() redacts the key id, so logging it cannot leak either.
   - createR2Client(creds, { S3Client }): the farm's construction. Region
     "auto", the account endpoint, path-style addressing, and the one R2
     gotcha: requestChecksumCalculation and responseChecksumValidation are
     "WHEN_REQUIRED" (R2 rejects the SDK's default flexible checksums on PUT
     and mis-validates them on GET). The SDK's own User-Agent is left alone:
     this package defines no identity strings (config.mjs header).
   - listPrefix(client, bucket, prefix): ListObjectsV2 pages, following
     NextContinuationToken, yielding {key, size, etag, lastModified}.
   - getObject(client, bucket, key): the whole body as a Buffer via the SDK's
     Body.transformToByteArray(), capped at MAX_OBJECT_BYTES (R2Error
     TOO_LARGE), with the farm's `sha256` user metadata (hex sha256 of the
     body bytes; the SDK lowercases metadata keys) as `sha256Meta`.

   Verified against the pinned @aws-sdk/client-s3 3.1146.0 in this
   package's lockfile: Body.transformToByteArray comes from
   @smithy/core's sdk-stream-mixin, and S3Client runs
   resolveFlexibleChecksumsConfig, which takes both "WHEN_REQUIRED" options.

   The SDK is imported lazily, only when a caller does not inject the class,
   so the module loads without node_modules. */
import { createHash } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BUCKET, R2_ENV } from "./config.mjs";

export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

/** The farm's credential-file key aliases, matched after lowercasing. */
export const ALIASES = Object.freeze({
  accessKeyId: Object.freeze(["access_key_id", "r2_access_key_id", "aws_access_key_id"]),
  secretAccessKey: Object.freeze(["secret_access_key", "r2_secret_access_key", "aws_secret_access_key"]),
  endpoint: Object.freeze(["s3_api_endpoint", "endpoint", "endpoint_url", "r2_s3_endpoint"]),
  bucket: Object.freeze(["bucket", "r2_bucket"]),
});

export class R2Error extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "R2Error";
    this.code = code;
  }
}

/** Default credential file, outside the tree (HUMAN-ACTIONS #138). */
export function defaultCredentialsFile(homedir = osHomedir) {
  return join(homedir(), ".foray", "r2-credentials");
}

/** Parses `key = value` lines into {field: value} through ALIASES. */
export function parseCredentialsText(text) {
  const byAlias = new Map();
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) byAlias.set(alias, field);
  }
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const field = byAlias.get(line.slice(0, eq).trim().toLowerCase());
    const value = line.slice(eq + 1).trim();
    if (field && value !== "" && out[field] === undefined) out[field] = value;
  }
  return out;
}

function credentials({ accessKeyId, secretAccessKey, endpoint, bucket }) {
  const creds = { accessKeyId, endpoint, bucket: bucket || DEFAULT_BUCKET };
  Object.defineProperty(creds, "secretAccessKey", { value: secretAccessKey, enumerable: false });
  Object.defineProperty(creds, "toJSON", {
    value() {
      return { accessKeyId: "<redacted>", endpoint: this.endpoint, bucket: this.bucket };
    },
    enumerable: false,
  });
  return creds;
}

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

/**
 * @param {{env?: object, readFile?: (path: string) => string | Promise<string>, homedir?: () => string}} options
 * @returns {Promise<{accessKeyId: string, secretAccessKey: string, endpoint: string, bucket: string}>}
 */
export async function loadR2Credentials({ env = process.env, readFile = (p) => fsReadFile(p, "utf8"), homedir = osHomedir } = {}) {
  const fromEnv = {
    accessKeyId: env[R2_ENV.accessKeyId],
    secretAccessKey: env[R2_ENV.secretAccessKey],
    endpoint: env[R2_ENV.endpoint],
  };
  if (nonEmpty(fromEnv.accessKeyId) && nonEmpty(fromEnv.secretAccessKey) && nonEmpty(fromEnv.endpoint)) {
    return credentials({ ...fromEnv, bucket: env[R2_ENV.bucket] });
  }

  const fileVar = env[R2_ENV.credentialsFile];
  const file = nonEmpty(fileVar) ? fileVar : defaultCredentialsFile(homedir);
  const fileLabel = nonEmpty(fileVar) ? `${R2_ENV.credentialsFile}=${file}` : `${R2_ENV.credentialsFile} unset, default ${file}`;
  const tried = `env (${R2_ENV.accessKeyId}, ${R2_ENV.secretAccessKey}, ${R2_ENV.endpoint}) incomplete; file (${fileLabel})`;

  let text;
  try {
    text = await readFile(file);
  } catch (e) {
    throw new R2Error("NO_CREDENTIALS", `${tried}: ${e?.code ?? "unreadable"}`);
  }
  const parsed = parseCredentialsText(text);
  const missing = ["accessKeyId", "secretAccessKey", "endpoint"].filter((f) => !nonEmpty(parsed[f]));
  if (missing.length > 0) {
    throw new R2Error("NO_CREDENTIALS", `${tried}: file lacks ${missing.join(", ")}`);
  }
  return credentials({ ...parsed, bucket: nonEmpty(env[R2_ENV.bucket]) ? env[R2_ENV.bucket] : parsed.bucket });
}

async function sdk() {
  return import("@aws-sdk/client-s3");
}

/** The farm's S3 client construction (see the file header). */
export async function createR2Client(creds, { S3Client } = {}) {
  const Client = S3Client ?? (await sdk()).S3Client;
  return new Client({
    region: "auto",
    endpoint: creds.endpoint,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** Every object under `prefix`, page after page. */
export async function* listPrefix(client, bucket, prefix, { ListObjectsV2Command } = {}) {
  const Command = ListObjectsV2Command ?? (await sdk()).ListObjectsV2Command;
  let token;
  do {
    const page = await client.send(new Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      yield { key: o.Key, size: o.Size ?? null, etag: o.ETag ?? null, lastModified: o.LastModified ?? null };
    }
    token = page.IsTruncated === false ? undefined : page.NextContinuationToken;
  } while (token);
}

/** One object, fully read. */
export async function getObject(client, bucket, key, { GetObjectCommand, maxBytes = MAX_OBJECT_BYTES } = {}) {
  const Command = GetObjectCommand ?? (await sdk()).GetObjectCommand;
  const res = await client.send(new Command({ Bucket: bucket, Key: key }));
  if (typeof res.ContentLength === "number" && res.ContentLength > maxBytes) {
    throw new R2Error("TOO_LARGE", `${key}: ${res.ContentLength} bytes > ${maxBytes}`);
  }
  if (!res.Body || typeof res.Body.transformToByteArray !== "function") {
    throw new R2Error("NO_BODY", key);
  }
  const body = Buffer.from(await res.Body.transformToByteArray());
  if (body.length > maxBytes) throw new R2Error("TOO_LARGE", `${key}: ${body.length} bytes > ${maxBytes}`);
  const metadata = res.Metadata ?? {};
  return {
    body,
    sha256Meta: metadata["sha256"] ?? metadata["x-amz-meta-sha256"] ?? null,
    etag: res.ETag ?? null,
    size: body.length,
  };
}

/** Hex sha256 of a buffer (the farm's `sha256` metadata format). */
export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
