import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { chromium, type Browser } from "playwright-core";

import { loadConfig } from "../../src/config.js";
import { ReadError } from "../../src/errors.js";
import { browserLaunchOptions, pageReadinessRuntime } from "../../src/fetch/browser.js";
import {
  waitForBrowserReadiness,
  waitForTargetReadiness,
} from "../../src/runtime/readiness.js";
import {
  evaluateReadinessRun,
  readinessStrategyIds,
  summarizeReadinessRuns,
  type ReadinessCase,
  type ReadinessObservation,
  type ReadinessRunRecord,
  type ReadinessStrategyId,
} from "./contract.js";
import { listen, positiveInteger } from "../harness/runtime.js";

type ControlledSite = {
  origin: string;
  close(): Promise<void>;
};

const readinessArticle =
  "Evidence, context, and complete facts make a rendered artifact useful. ".repeat(12);

export const readinessCases: ReadinessCase[] = [
  {
    id: "instant", path: "/readiness/instant", category: "instant",
    truth: { expectedOutcome: "artifact", requiredText: ["READY:instant"], forbiddenText: [],
      minTextCharacters: 500, minItems: 0, requiresTerminalMarker: true },
    targetSelector: "[data-terminal='true']", interaction: "none",
  },
  {
    id: "delayed", path: "/readiness/delayed", category: "delayed",
    truth: { expectedOutcome: "artifact", requiredText: ["READY:delayed"],
      forbiddenText: ["Loading delayed content"], minTextCharacters: 500,
      minItems: 0, requiresTerminalMarker: true },
    targetSelector: "[data-terminal='true']", interaction: "none",
  },
  {
    id: "skeleton", path: "/readiness/skeleton", category: "skeleton",
    truth: { expectedOutcome: "artifact", requiredText: ["READY:skeleton"],
      forbiddenText: ["Loading article"], minTextCharacters: 500,
      minItems: 0, requiresTerminalMarker: true },
    targetSelector: "[data-terminal='true']", interaction: "none",
  },
  {
    id: "changing", path: "/readiness/changing", category: "unstable",
    truth: { expectedOutcome: "artifact", requiredText: ["READY:changing"], forbiddenText: [],
      minTextCharacters: 500, minItems: 0, requiresTerminalMarker: true },
    targetSelector: "[data-terminal='true']", interaction: "none",
  },
  {
    id: "infinite-scroll", path: "/readiness/infinite", category: "interaction",
    truth: { expectedOutcome: "artifact", requiredText: ["ITEM:30", "READY:infinite"],
      forbiddenText: [], minTextCharacters: 500, minItems: 30, requiresTerminalMarker: true },
    targetSelector: "[data-terminal='true']", interaction: "scroll-to-end",
  },
];

function documentHtml(body: string, script = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Readiness</title>
    <style>body{margin:0;font:16px sans-serif}.item{min-height:180px;padding:8px}</style>
    </head><body>${body}${script.length === 0 ? "" : `<script>${script}</script>`}</body></html>`;
}

function readinessHtml(pathname: string): string | null {
  if (pathname.endsWith("/instant")) {
    return documentHtml(
      `<main data-terminal="true"><h1>READY:instant</h1><p>${readinessArticle}</p></main>`,
    );
  }
  if (pathname.endsWith("/delayed")) {
    return documentHtml(
      "<main id='content'>Loading delayed content</main>",
      `setTimeout(()=>{content.innerHTML='<article data-terminal="true"><h1>READY:delayed</h1><p>${readinessArticle}</p></article>'},900)`,
    );
  }
  if (pathname.endsWith("/skeleton")) {
    return documentHtml(
      "<main id='content'><div>Loading article</div></main>",
      `setTimeout(()=>{content.innerHTML='<article data-terminal="true"><h1>READY:skeleton</h1><p>${readinessArticle}</p></article>'},1200)`,
    );
  }
  if (pathname.endsWith("/changing")) {
    return documentHtml(
      `<main data-terminal="true"><h1>READY:changing</h1><p>${readinessArticle}</p><output id="tick">0</output></main>`,
      "let value=0;setInterval(()=>{tick.textContent=String(++value)},100)",
    );
  }
  if (!pathname.endsWith("/infinite")) return null;
  const initial = Array.from({ length: 5 }, (_, index) =>
    `<section class="item" data-item><b>ITEM:${index + 1}</b> ${readinessArticle.slice(0, 120)}</section>`)
    .join("");
  return documentHtml(`<main id="items">${initial}</main><footer id="terminal"></footer>`, `
    let count=5,loading=false;
    addEventListener('scroll',()=>{
      if(loading||innerHeight+scrollY<document.body.scrollHeight-5||count>=30)return;
      loading=true;setTimeout(()=>{
        const end=Math.min(30,count+5);
        for(let value=count+1;value<=end;value++)items.insertAdjacentHTML('beforeend',
          '<section class="item" data-item><b>ITEM:'+value+'</b> ${readinessArticle.slice(0, 120)}</section>');
        count=end;loading=false;
        if(count===30){terminal.dataset.terminal='true';terminal.textContent='READY:infinite'}
      },80)
    })`);
}

export async function createReadinessSite(): Promise<ControlledSite> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://readiness.test").pathname;
    const body = readinessHtml(pathname);
    if (body === null) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(body);
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolveClose, reject) =>
      server.close((error) => error === undefined ? resolveClose() : reject(error))),
  };
}

function readinessTimedOut(error: unknown): boolean {
  return (error instanceof ReadError && error.code === "FETCH_TIMEOUT") ||
    (error instanceof Error && error.name === "TimeoutError");
}

async function observeReadinessStrategy(
  browser: Browser,
  origin: string,
  benchmarkCase: ReadinessCase,
  strategy: ReadinessStrategyId,
  timeoutMs: number,
): Promise<ReadinessObservation> {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 720 } });
  const page = await context.newPage();
  const startedAt = performance.now();
  try {
    await page.goto(`${origin}${benchmarkCase.path}`, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (strategy === "fixed-750") {
      await page.waitForTimeout(750);
    } else if (strategy === "adaptive") {
      await waitForBrowserReadiness(pageReadinessRuntime(page), { timeoutMs });
    } else {
      await waitForTargetReadiness(pageReadinessRuntime(page), {
        target: { selector: benchmarkCase.targetSelector },
        ...(benchmarkCase.interaction === "scroll-to-end"
          ? {
              interaction: {
                type: "scroll-to-end" as const,
                maxSteps: 40,
                stepDelayMs: 50,
              },
            }
          : {}),
      }, { timeoutMs });
    }
    return {
      outcome: "artifact",
      durationMs: performance.now() - startedAt,
      text: await page.locator("body").innerText(),
      itemCount: await page.locator("[data-item]").count(),
      terminalMarker: await page.locator("[data-terminal='true']").count() > 0,
    };
  } catch (error) {
    if (readinessTimedOut(error)) {
      return {
        outcome: "timeout",
        durationMs: performance.now() - startedAt,
        errorCode: "FETCH_TIMEOUT",
      };
    }
    throw error;
  } finally {
    await context.close();
  }
}

function compactReadinessRecord(record: ReadinessRunRecord) {
  const observation = record.observation.outcome === "timeout"
    ? record.observation
    : {
        outcome: record.observation.outcome,
        durationMs: record.observation.durationMs,
        textCharacters: record.observation.text.length,
        itemCount: record.observation.itemCount,
        terminalMarker: record.observation.terminalMarker,
      };
  return {
    strategy: record.strategy,
    caseId: record.caseId,
    repeat: record.repeat,
    observation,
    evaluation: {
      valid: record.evaluation.valid,
      falseSuccess: record.evaluation.falseSuccess,
      reason: record.evaluation.reason,
      assertions: record.evaluation.assertions.map(({ name, passed }) => ({ name, passed })),
    },
  };
}

export async function runReadinessTournament(repeats = 5, timeoutMs = 2_000) {
  positiveInteger(repeats, "repeats");
  positiveInteger(timeoutMs, "timeoutMs");
  const site = await createReadinessSite();
  const config = loadConfig();
  let browser: Browser | null = null;
  const records: ReadinessRunRecord[] = [];
  try {
    browser = await chromium.launch(browserLaunchOptions(config, true));
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const [caseIndex, benchmarkCase] of readinessCases.entries()) {
        const offset = (repeat + caseIndex) % readinessStrategyIds.length;
        const strategies = readinessStrategyIds.slice(offset).concat(
          readinessStrategyIds.slice(0, offset),
        );
        for (const strategy of strategies) {
          const observation = await observeReadinessStrategy(
            browser, site.origin, benchmarkCase, strategy, timeoutMs,
          );
          records.push({
            strategy,
            caseId: benchmarkCase.id,
            repeat,
            observation,
            evaluation: evaluateReadinessRun(benchmarkCase.truth, observation),
          });
        }
      }
    }
    const report = {
      protocolVersion: 1,
      benchmark: "browser-readiness-tournament",
      generatedAt: new Date().toISOString(),
      repeats,
      timeoutMs,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        browser: browser.version(),
        headless: true,
      },
      cases: readinessCases,
      strategies: readinessStrategyIds,
      records: records.map(compactReadinessRecord),
      summaries: summarizeReadinessRuns(records),
      caseSummaries: readinessStrategyIds.flatMap((strategy) => readinessCases.map((value) => ({
        caseId: value.id,
        ...summarizeReadinessRuns(records.filter((record) =>
          record.strategy === strategy && record.caseId === value.id))[0],
      }))),
    };
    const reportsDir = resolve("benchmarks/reports");
    await mkdir(reportsDir, { recursive: true });
    await writeFile(
      resolve(reportsDir, "readiness-latest.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    return report;
  } finally {
    await browser?.close();
    await site.close();
  }
}
