/* Module-loader hooks for `record.mjs --mutate` (NE-03, plan §6.3).

   A mutation smoke has to change a rule WITHOUT editing the working tree: a
   crashed run must never leave a mutant behind in a file someone then commits,
   and the laptop this runs on has no room for a second checkout. So the
   mutant exists only in the child process's module loader — this hook swaps
   one exact string in one file's source as it is loaded, and the bytes on disk
   are never touched.

   Loaded by mutate-register.mjs via `node --import`; configured through the
   PARITY_MUTATION environment variable, which record.mjs sets:
     {"url": "<file URL of the module>", "find": "<exact text>", "replace": "<text>"}

   The hook REFUSES rather than guessing: a `find` that is not present exactly
   once throws at load time, so a mutation whose anchor drifted fails loudly
   instead of "surviving" because nothing was mutated. */

let mutation = null;

export function initialize(data) {
  mutation = data ?? null;
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!mutation || !same(url, mutation.url)) return result;
  const src = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
  const hits = src.split(mutation.find).length - 1;
  if (hits !== 1) {
    throw new Error(`parity mutation: expected exactly one occurrence of the anchor in ${url}, found ${hits}`);
  }
  return { ...result, source: src.replace(mutation.find, mutation.replace) };
}
