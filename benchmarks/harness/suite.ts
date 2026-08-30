import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildControlledFaultMatrix,
  controlledFaultEnvironment,
  createControlledFaultSite,
  type ControlledFaultScenario,
} from "../controlled-site/faults.js";
import {
  collectBenchmarkEnvironmentFingerprint,
  compareBenchmarkReports,
  createBenchmarkCaseSet,
  executeReaderBenchmarkCase,
  loadBenchmarkCaseSet,
  runBenchmarkCorpus,
  type BenchmarkCorpusReport,
  type BenchmarkReleaseComparison,
} from "./corpus.js";
import {
  benchmarkGateInputFromReports,
  evaluateBenchmarkGate,
  type BenchmarkGateEvaluation,
  type BenchmarkGateInput,
} from "./gates.js";

export type BenchmarkMode = "pr" | "nightly" | "release";

export type BenchmarkModeOptions = {
  mode: BenchmarkMode;
  repeats: number;
  comparePath: string | null;
};

export type BenchmarkSuiteResult = {
  mode: BenchmarkMode;
  reportPath: string;
  report: BenchmarkCorpusReport;
  comparison: BenchmarkReleaseComparison | null;
  gateInput: BenchmarkGateInput;
  gate: BenchmarkGateEvaluation;
  passed: boolean;
};

const controlledEnvironmentKeys = [
  "DIAOYAN_ALLOW_DNS_FAKE_IP",
  "DIAOYAN_CRAWL_MAX_RETRY_DELAY_MS",
  "DIAOYAN_CRAWL_MIN_HOST_INTERVAL_MS",
  "DIAOYAN_CRAWL_RETRY_BASE_MS",
  "DIAOYAN_DATA_DIR",
  "DIAOYAN_MAX_REDIRECTS",
  "DIAOYAN_MAX_RESPONSE_BYTES",
  "DIAOYAN_PROXY_URLS",
  "DIAOYAN_REQUEST_TIMEOUT_MS",
] as const;

function optionValue(arguments_: string[], index: number): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arguments_[index]} requires a value`);
  }
  return value;
}

export function parseBenchmarkModeOptions(arguments_: string[]): BenchmarkModeOptions {
  const options = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  let rawMode: string | null = null;
  let rawRepeats: string | null = null;
  let comparePath: string | null = null;
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    if (option !== "--mode" && option !== "--repeats" && option !== "--compare") {
      throw new Error(`unknown benchmark option: ${option ?? "<missing>"}`);
    }
    const value = optionValue(options, index);
    if (option === "--mode") rawMode = value;
    else if (option === "--repeats") rawRepeats = value;
    else comparePath = value;
  }
  if (rawMode === null) throw new Error("--mode is required");
  if (rawMode !== "pr" && rawMode !== "nightly" && rawMode !== "release") {
    throw new Error("--mode must be pr, nightly, or release");
  }
  const minimumRepeats = rawMode === "release" ? 30 : 5;
  const repeats = rawRepeats === null ? minimumRepeats : Number.parseInt(rawRepeats, 10);
  if (!Number.isSafeInteger(repeats) || String(repeats) !== rawRepeats && rawRepeats !== null) {
    throw new Error("--repeats must be a positive integer");
  }
  if (repeats < minimumRepeats) {
    throw new Error(`--repeats must be at least ${minimumRepeats} for ${rawMode}`);
  }
  if (rawMode === "release" && comparePath === null) {
    throw new Error("--compare is required for release");
  }
  if (rawMode !== "release" && comparePath !== null) {
    throw new Error("--compare is only valid for release");
  }
  return { mode: rawMode, repeats, comparePath };
}

function restoreEnvironment(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function readBaseline(path: string): Promise<BenchmarkCorpusReport> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (cause) {
    throw new Error(`failed to read benchmark baseline: ${path}`, { cause });
  }
  if (
    typeof value !== "object" || value === null ||
    (value as { protocolVersion?: unknown }).protocolVersion !== 1 ||
    !Array.isArray((value as { runs?: unknown }).runs)
  ) throw new Error("benchmark baseline is not a corpus report");
  return value as BenchmarkCorpusReport;
}

function prPassed(input: BenchmarkGateInput): boolean {
  return input.layers.controlled.distinctCases >= 40 &&
    input.layers.controlled.minRepeats >= 5 &&
    input.truthPassRate === 1 && input.falseSuccesses === 0 && input.harnessErrors === 0 &&
    input.provenanceCompleteness === 1 && input.plannedProviderViolations === 0 &&
    input.ledgerMismatches === 0 && input.budgetViolations === 0 &&
    input.policyViolations === 0 && input.scopeLeaks === 0;
}

function stableConfigurationHash(baseHash: string, caseSetHash: string): string {
  return `sha256:${createHash("sha256").update(`${baseHash}:${caseSetHash}`).digest("hex")}`;
}

export async function runBenchmarkSuite(
  options: BenchmarkModeOptions,
  rootDirectory = resolve("."),
): Promise<BenchmarkSuiteResult> {
  const root = resolve(rootDirectory);
  const site = await createControlledFaultSite();
  try {
    const controlled = buildControlledFaultMatrix(site);
    const fixtureById = new Map(controlled.map((fixture) => [fixture.benchmarkCase.id, fixture]));
    const includeLive = options.mode !== "pr";
    const live = includeLive
      ? await loadBenchmarkCaseSet(resolve(root, "benchmarks/cases"), "public-live-v1")
      : null;
    const caseSet = createBenchmarkCaseSet(
      [...controlled.map(({ benchmarkCase }) => benchmarkCase), ...(live?.cases ?? [])],
      includeLive ? "public-nightly-v1" : "public-pr-v1",
    );
    const baseFingerprint = await collectBenchmarkEnvironmentFingerprint();
    const fingerprint = {
      ...baseFingerprint,
      configurationHash: stableConfigurationHash(
        baseFingerprint.configurationHash,
        caseSet.caseSetHash,
      ),
    };
    const report = await runBenchmarkCorpus(caseSet, async (benchmarkCase) => {
      const dataDirectory = await mkdtemp(join(tmpdir(), "diaoyan-benchmark-run-"));
      const snapshot = new Map<string, string | undefined>(
        controlledEnvironmentKeys.map((key) => [key, process.env[key]]),
      );
      try {
        const fixture = fixtureById.get(benchmarkCase.id);
        if (fixture !== undefined) {
          const scenario = benchmarkCase.id.slice("controlled-".length) as ControlledFaultScenario;
          site.reset();
          site.select(scenario);
          Object.assign(process.env, controlledFaultEnvironment(site, dataDirectory, fixture));
        } else {
          process.env.DIAOYAN_DATA_DIR = dataDirectory;
        }
        return await executeReaderBenchmarkCase(benchmarkCase);
      } finally {
        restoreEnvironment(snapshot);
        await rm(dataDirectory, { recursive: true, force: true });
      }
    }, { repeats: options.repeats, fingerprint });

    const comparison = options.comparePath === null
      ? null
      : compareBenchmarkReports(await readBaseline(options.comparePath), report);
    const gateInput = benchmarkGateInputFromReports([report], comparison);
    const gate = evaluateBenchmarkGate(gateInput);
    const reportsDirectory = resolve(root, "benchmarks/reports");
    await mkdir(reportsDirectory, { recursive: true });
    const reportPath = resolve(reportsDirectory, `${options.mode}-latest.json`);
    await Promise.all([
      writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
      writeFile(
        resolve(reportsDirectory, `${options.mode}-latest.jsonl`),
        `${report.runs.map((run) => JSON.stringify(run)).join("\n")}\n`,
        "utf8",
      ),
      writeFile(
        resolve(reportsDirectory, `${options.mode}-gate.json`),
        `${JSON.stringify({ input: gateInput, evaluation: gate }, null, 2)}\n`,
        "utf8",
      ),
      ...(comparison === null
        ? []
        : [writeFile(
            resolve(reportsDirectory, "release-comparison.json"),
            `${JSON.stringify(comparison, null, 2)}\n`,
            "utf8",
          )]),
    ]);
    const passed = options.mode === "pr"
      ? prPassed(gateInput)
      : options.mode === "nightly"
        ? gate.gates.canaryReady
        : gate.gates.releaseCandidate;
    return { mode: options.mode, reportPath, report, comparison, gateInput, gate, passed };
  } finally {
    await site.close();
  }
}
