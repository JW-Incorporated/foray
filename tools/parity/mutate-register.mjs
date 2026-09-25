/* `node --import` entry for record.mjs --mutate: registers mutate-hooks.mjs
   with the mutation named in PARITY_MUTATION. See mutate-hooks.mjs. */
import { register } from "node:module";

const raw = process.env.PARITY_MUTATION;
if (raw) {
  // A mutant the suite never loads is not a harness error: the test then
  // passes, and record.mjs reports the mutant as SURVIVED, which is the truth.
  register(new URL("./mutate-hooks.mjs", import.meta.url), { data: JSON.parse(raw) });
}
