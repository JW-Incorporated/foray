import * as fs from "fs";
import * as path from "path";
import { defaultBudgetGuard } from "../cost/budgetGuard";
import { defaultUnitBudgetGuard, type UnitBudgetGuard } from "../cost/unitBudget";
import { loadCatalogueData, type CatalogueData } from "../generation/catalogueLookup";
import { judgeThresholdEntry, judgeThresholdSetting } from "../generation/gateConfig";
import { HttpJevClient, NullJevClient, createDirectJevClient, createJevClient, meteredJevClient } from "../generation/jevClient";
import { JUDGE_IDS, type JevClient, type JudgeId } from "../generation/jevTypes";
import {
  EXAMPLE_KINDS,
  JevCalibrationJudge,
  LabelledExampleSchema,
  calibrate,
  clipExamples,
  dataLocalRefusal,
  extractClips,
  extractPages,
  formatCalibration,
  pageExampleRow,
  parseCalibrationExport,
  thresholdNameFor,
  type CalibrationExport,
  type CalibrationJudge,
  type CalibrationResult,
  type ExampleKind,
  type LabelledExample,
  type UnlabelledExample
} from "../generation/judgeCalibration";
import { QwenJudgeClient } from "../generation/qwenJudgeClient";
import { FileTranscriptCueProvider, loadTranscriptArchive, type TranscriptCueProvider, type TranscriptDigestEntry } from "../generation/transcriptArchiveLookup";
import { LANE_IDS, type LaneId } from "../config/machineProfiles";
import { DEFAULT_AUTHOR_ID } from "../types/generation";

/**
 * GV-103 (docs/roadmap/generation-v2.md, W5-07): the judge calibration CLI.
 * Launched by tools/generation/calibrate-judges.mjs (cwd backend/).
 *
 *   EXTRACT: turn --keep-calibration exports into rows to label
 *     calibrate-judges --extract <export.json | dir of calibration-*.json>
 *                      --out data-local/judge-calibration/to-label.jsonl
 *                      [--run-verdict-labels]
 *   One page-support row per narration page, and a clip-subject and a
 *   clip-claim row per placed clip, each with `label: null` and
 *   `labelSource: null` for the founder (or the review lane, GV-41) to set
 *   to true/false and 'founder' / 'review-lane'. --run-verdict-labels fills
 *   the page rows' labels from the pipeline's own verifier verdicts
 *   ('run-verdict'); use it only if the founder allows those on #1163
 *   (OQ-06). No model is asked.
 *
 *   CALIBRATE: the agreement-by-threshold table
 *     calibrate-judges --labels <jsonl> --kind page-support|clip-subject|clip-claim
 *                      --judge jev|qwen --out data-local/judge-calibration/<name>.json
 *                      [--thresholds 0.5,0.6,...] [--allow-run-verdicts]
 *                      [--qwen-lane spark|second] [--max-in-flight N]
 *   Asks the chosen judge the pipeline's own questions about every labelled
 *   row of that kind (rows still `label: null` are skipped), prints the
 *   table and the lowest threshold reaching 0.9 agreement, names the gate
 *   variable it belongs in (GV-47's per-judge keys), and writes the table as
 *   JSON. Jev needs JEV_API_KEY or JEV_KEY_FILE; the Qwen judge needs
 *   FORAY_LLM_BASE_URL (LiteLLM). Every ask is metered through BudgetGuard.
 *   No Anthropic call, ever.
 *
 * Every --out must be under data-local/ (gitignored): rows and tables hold
 * transcript, script and evidence text that never goes into git.
 */

export class CalibrateArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrateArgError";
  }
}

export type CalibrateArgs =
  | { mode: "extract"; extract: string; out: string; runVerdictLabels: boolean }
  | {
      mode: "calibrate";
      labels: string;
      kind: ExampleKind;
      judge: JudgeId;
      out: string;
      thresholds?: number[];
      allowRunVerdicts: boolean;
      qwenLane: LaneId;
      maxInFlight?: number;
    };

const USAGE =
  "Usage: calibrate-judges --extract <export.json|dir> --out data-local/... [--run-verdict-labels]\n" +
  "   or: calibrate-judges --labels <jsonl> --kind page-support|clip-subject|clip-claim --judge jev|qwen --out data-local/... " +
  "[--thresholds a,b,...] [--allow-run-verdicts] [--qwen-lane spark|second] [--max-in-flight N]";

export function parseCalibrateArgs(argv: readonly string[], cwd: string = process.cwd(), repoRoot?: string): CalibrateArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--") || v.trim() === "") throw new CalibrateArgError(`${flag} needs a value`);
    return v;
  };
  const out = value("--out");
  if (out === undefined) throw new CalibrateArgError(`--out is required\n${USAGE}`);
  const refusal = dataLocalRefusal("--out", out, cwd, repoRoot);
  if (refusal !== null) throw new CalibrateArgError(refusal);

  const extract = value("--extract");
  const labels = value("--labels");
  if (extract !== undefined && labels !== undefined) throw new CalibrateArgError("--extract and --labels are separate runs; give one");
  if (extract !== undefined) return { mode: "extract", extract, out, runVerdictLabels: argv.includes("--run-verdict-labels") };
  if (labels === undefined) throw new CalibrateArgError(`give --extract or --labels\n${USAGE}`);

  const kind = value("--kind");
  if (kind === undefined || !(EXAMPLE_KINDS as readonly string[]).includes(kind)) throw new CalibrateArgError(`--kind must be one of ${EXAMPLE_KINDS.join(", ")}`);
  const judge = value("--judge");
  if (judge === undefined || !(JUDGE_IDS as readonly string[]).includes(judge)) throw new CalibrateArgError(`--judge must be one of ${JUDGE_IDS.join(", ")}`);
  const lane = value("--qwen-lane") ?? "second";
  if (!(LANE_IDS as readonly string[]).includes(lane)) throw new CalibrateArgError(`--qwen-lane must be one of ${LANE_IDS.join(", ")}`);
  const thresholdsRaw = value("--thresholds");
  let thresholds: number[] | undefined;
  if (thresholdsRaw !== undefined) {
    thresholds = thresholdsRaw.split(",").map((t) => Number(t.trim()));
    if (thresholds.length === 0 || thresholds.some((t) => !Number.isFinite(t))) throw new CalibrateArgError("--thresholds must be a comma list of numbers");
  }
  const inFlightRaw = value("--max-in-flight");
  const maxInFlight = inFlightRaw === undefined ? undefined : Number(inFlightRaw);
  if (maxInFlight !== undefined && !(Number.isInteger(maxInFlight) && maxInFlight > 0)) throw new CalibrateArgError("--max-in-flight must be a positive integer");
  return {
    mode: "calibrate",
    labels,
    kind: kind as ExampleKind,
    judge: judge as JudgeId,
    out,
    ...(thresholds ? { thresholds } : {}),
    allowRunVerdicts: argv.includes("--allow-run-verdicts"),
    qwenLane: lane as LaneId,
    ...(maxInFlight !== undefined ? { maxInFlight } : {})
  };
}

/** The export files `p` names: the file itself, or every
 * `calibration-<hash>.json` in the directory (what --keep-calibration writes),
 * sorted. */
export function exportFiles(p: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's own --extract path.
  if (!fs.statSync(p).isDirectory()) return [p];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same.
  return fs
    .readdirSync(p)
    .filter((f) => /^calibration-[0-9a-f]+\.json$/.test(f))
    .sort()
    .map((f) => path.join(p, f));
}

export interface ExtractDeps {
  cueProvider?: TranscriptCueProvider;
  transcriptArchive?: TranscriptDigestEntry[];
  catalogue?: CatalogueData;
}

/** The rows to label for `exports`: every page, then every clip (subject and
 * claim), export by export. Also the clips skipped, by reason. */
export function rowsToLabel(
  exports: readonly CalibrationExport[],
  deps: Required<ExtractDeps>,
  runVerdictLabels: boolean
): { rows: UnlabelledExample[]; skipped: Record<string, number> } {
  const rows: UnlabelledExample[] = [];
  const skipped: Record<string, number> = {};
  for (const exp of exports) {
    for (const page of extractPages(exp)) rows.push(pageExampleRow(page, runVerdictLabels));
    const clips = extractClips(exp, deps);
    for (const row of clips.rows) rows.push(...clipExamples(row));
    for (const s of clips.skipped) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
  }
  return { rows, skipped };
}

/** The labelled rows of `kind` in a JSONL: rows still `label: null` are
 * skipped and counted; a malformed line throws naming its line number. */
export function readLabels(text: string, kind: ExampleKind): { examples: LabelledExample[]; unlabelled: number } {
  const examples: LabelledExample[] = [];
  let unlabelled = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new CalibrateArgError(`--labels line ${i + 1} is not JSON`);
    }
    const row = raw as { kind?: unknown; label?: unknown };
    if (row.kind !== kind) return;
    if (row.label === null || row.label === undefined) {
      unlabelled += 1;
      return;
    }
    const parsed = LabelledExampleSchema.safeParse(raw);
    if (!parsed.success) throw new CalibrateArgError(`--labels line ${i + 1} is not a labelled example (label true/false, labelSource founder|review-lane|run-verdict)`);
    examples.push(parsed.data);
  });
  return { examples, unlabelled };
}

/** The judge to calibrate: Jev itself (whatever the routing says), or the
 * Qwen judge on `lane`; null with the reason when it cannot answer here. */
export function calibrationClient(judge: JudgeId, lane: LaneId, source: NodeJS.ProcessEnv = process.env): { client: JevClient } | { error: string } {
  if (judge === "jev") {
    const client = createDirectJevClient();
    return client instanceof HttpJevClient ? { client } : { error: "no Jev key: set JEV_API_KEY or JEV_KEY_FILE; nothing was sent" };
  }
  try {
    const client = createJevClient({ source: { ...source, FORAY_STAGE_JUDGE: `local:${lane}` } });
    if (client instanceof QwenJudgeClient) return { client };
    return { error: client instanceof NullJevClient ? "the Qwen judge is not configured" : "the judge route did not give the Qwen judge" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CalibrateDeps extends ExtractDeps {
  /** The judge to ask (default: built from --judge, metered). */
  judge?: CalibrationJudge;
  /** GV-126: the client the default judge meters (default
   * `calibrationClient(--judge, --qwen-lane)`). Ignored when `judge` is given. */
  client?: JevClient;
  /** GV-126: the unit guard the metered client reserves `jevCalls` from
   * (default defaultUnitBudgetGuard). */
  unitGuard?: UnitBudgetGuard;
  log?: (line: string) => void;
  /** What relative paths are read against (default process.cwd()). */
  cwd?: string;
  /** GV-126: the repository whose data-local/ directories --out must sit
   * inside (default: this checkout's root). */
  repoRoot?: string;
}

/**
 * GV-126 (#1413 item 32): the metering session one calibration run's asks
 * are charged to. Under a session `meteredJevClient` reserves one `jevCalls`
 * unit per ask that goes to Jev, so the per-session cap
 * (FORAY_JEV_CALLS_PER_FORAY; untiered, the long tier's) bounds a
 * calibration run as it bounds a Foray; without one only the dollar caps
 * applied. A Qwen-judge ask is not a Jev call and reserves nothing.
 */
export function calibrationSessionId(kind: ExampleKind, judge: JudgeId): string {
  return `calibrate:${kind}:${judge}`;
}

function writeOut(out: string, body: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- --out, refused unless under data-local/.
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same.
  fs.writeFileSync(out, body);
}

/** The CLI. Returns the exit code: 0 done, 1 refused or nothing to do, 2 a
 * crash (the entry below). */
export async function main(argv: string[] = process.argv.slice(2), deps: CalibrateDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const cwd = deps.cwd ?? process.cwd();
  const at = (p: string): string => path.resolve(cwd, p);
  let args: CalibrateArgs;
  try {
    args = parseCalibrateArgs(argv, cwd, deps.repoRoot);
  } catch (err) {
    if (!(err instanceof CalibrateArgError)) throw err;
    console.error(err.message);
    return 1;
  }

  if (args.mode === "extract") {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's own export files.
    const exports = exportFiles(at(args.extract)).map((f) => parseCalibrationExport(JSON.parse(fs.readFileSync(f, "utf8"))));
    if (exports.length === 0) {
      console.error(`calibrate-judges: no calibration-*.json under ${args.extract}`);
      return 1;
    }
    const { rows, skipped } = rowsToLabel(
      exports,
      {
        cueProvider: deps.cueProvider ?? new FileTranscriptCueProvider(),
        transcriptArchive: deps.transcriptArchive ?? loadTranscriptArchive(),
        catalogue: deps.catalogue ?? loadCatalogueData()
      },
      args.runVerdictLabels
    );
    writeOut(at(args.out), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    const count = (k: ExampleKind): number => rows.filter((r) => r.kind === k).length;
    log(
      `calibrate-judges: ${exports.length} export(s) -> ${rows.length} row(s) in ${args.out}: ` +
        `${count("page-support")} page, ${count("clip-subject")} clip` +
        (Object.keys(skipped).length ? `; clips skipped ${JSON.stringify(skipped)}` : "")
    );
    return 0;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's own --labels file.
  const { examples, unlabelled } = readLabels(fs.readFileSync(at(args.labels), "utf8"), args.kind);
  if (examples.length === 0) {
    console.error(`calibrate-judges: no labelled ${args.kind} rows in ${args.labels} (${unlabelled} still unlabelled)`);
    return 1;
  }
  let judge = deps.judge;
  if (!judge) {
    const built = deps.client ? { client: deps.client } : calibrationClient(args.judge, args.qwenLane);
    if ("error" in built) {
      console.error(`calibrate-judges: ${built.error}`);
      return 1;
    }
    const metered = meteredJevClient(built.client, {
      guard: defaultBudgetGuard,
      userId: DEFAULT_AUTHOR_ID,
      sessionId: calibrationSessionId(args.kind, args.judge),
      unitGuard: deps.unitGuard ?? defaultUnitBudgetGuard
    });
    judge = new JevCalibrationJudge(metered, args.judge, args.maxInFlight !== undefined ? { maxInFlight: args.maxInFlight } : {});
  }
  if (judge.judge !== args.judge) {
    console.error(`calibrate-judges: the judge given answers as ${judge.judge}, not ${args.judge}`);
    return 1;
  }
  const result: CalibrationResult = await calibrate(examples, judge, args.thresholds, { allowRunVerdicts: args.allowRunVerdicts });
  for (const line of formatCalibration(result)) log(line);
  const name = thresholdNameFor(args.kind);
  const entry = judgeThresholdEntry(name, args.judge);
  const setting = result.recommended === null ? null : judgeThresholdSetting(name, args.judge, result.recommended);
  if (result.recommended !== null) {
    log(
      setting === null
        ? `(${result.recommended} is not a value ${entry.env} accepts; choose a threshold from the table)`
        : `gate setting: ${setting} (default ${String(entry.default)})` +
            (name === "clipLevel" ? "; clipLevel is shared by subject and claim, so set the higher of the two kinds' recommendations" : "")
    );
  }
  if (unlabelled > 0) log(`${unlabelled} ${args.kind} row(s) still unlabelled were skipped`);
  writeOut(at(args.out), `${JSON.stringify({ ...result, gateVariable: entry.env, gateDefault: entry.default, setting, unlabelled }, null, 2)}\n`);
  log(`table written to ${args.out}`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    }
  );
}
