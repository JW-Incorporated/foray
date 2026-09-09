/**
 * Ambient fallback for the plain-JS `.mjs` build/check scripts under
 * `tools/foray/` (`check-forays.mjs`, `check-narration.mjs`,
 * `measure-cadence.mjs`, ...) that generation code and its tests load —
 * some via dynamic `import()` (see the "WHY NOT REIMPLEMENT VALIDATION"
 * note in `finalizeForay.ts`), some via a static named import (e.g.
 * `test/measureCadence.test.ts`'s `import { computeCadence } from
 * "../../tools/foray/measure-cadence.mjs"`). Those scripts are called
 * as-is, never reimplemented or given a parallel type surface here,
 * since a second, hand-maintained description of their exports would
 * drift from the real thing exactly the way that comment warns against.
 *
 * The shorthand ambient declaration (no body) is deliberate: it makes
 * `tsc` treat every `*.mjs` module's export surface as `any`, which
 * silences TS7016 ("could not find a declaration file") for the dynamic
 * `import()` call sites AND allows named imports like `computeCadence`
 * above (an `export = mod`-shaped declaration blocks named-import syntax
 * even when `mod` is typed `any` — this form does not). It makes no
 * claim about any module's actual shape; every dynamic-import call site
 * still narrows the result with its own `as unknown as {...}` cast, same
 * as before this declaration existed.
 */
declare module "*.mjs";
