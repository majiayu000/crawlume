import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../../dist/app.js';
import { loadConfig } from '../../dist/config.js';

const [action = 'collect', outputArgument] = process.argv.slice(2);
if (!['collect', 'evaluate'].includes(action) || !outputArgument || !process.env.CRAWLUME_DATA_DIR) {
  throw new Error('Usage: CRAWLUME_DATA_DIR=<dedicated directory> pnpm trial:docs <collect|evaluate> <report directory>');
}
const config = loadConfig();
if (!config.localIndexEnabled) throw new Error('Set CRAWLUME_LOCAL_INDEX_ENABLED=1.');
const fixtureText = readFileSync(new URL('./cases.json', import.meta.url), 'utf8');
const fixtureHash = createHash('sha256').update(fixtureText).digest('hex');
const fixture = JSON.parse(fixtureText);
const output = resolve(outputArgument);
mkdirSync(join(output, 'pages'), { recursive: true });
const statePath = join(output, 'collection.json');
function save(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
const app = createApp(config, { runCrawlWorker: action === 'collect', runMonitorWorker: false });
try {
  let state;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.fixtureHash !== fixtureHash || state.dataDir !== resolve(config.dataDir)) {
      throw new Error('Collection belongs to a different fixture or data directory; choose a new report directory.');
    }
  } else {
    if (action !== 'collect') throw new Error('Collect the corpus before evaluating.');
    for (const item of fixture.cases) app.verticalSearch.addManualUrl(item.url);
    const run = app.verticalSearch.startDailyRun();
    state = { fixtureHash, dataDir: resolve(config.dataDir), runId: run.id, startedAt: new Date().toISOString() };
    save(statePath, state);
  }
  let run = app.verticalSearch.refreshRun(state.runId);
  if (action === 'collect') {
    for (const job of run.jobs) {
      if (!job.jobId) continue;
      let cursor = 0;
      while (true) {
        const batch = await app.jobs.waitForPages(job.jobId, cursor, 100, 30_000);
        cursor = batch.nextSequence;
        if (batch.pages.length) console.log(`Published ${batch.pages.length}: ${batch.pages.map(p => `${p.status} ${p.url}`).join(', ')}`);
        if (batch.done) break;
        if (!batch.pages.length) console.log(`Waiting for ${job.jobId}`);
      }
    }
    run = app.verticalSearch.refreshRun(state.runId);
  }
  if (run.status === 'running') throw new Error('Collection is still running; resume collect first.');
  const publications = run.jobs.flatMap(job => job.jobId ? app.jobs.pages(job.jobId, 0, 100).pages : []);
  const seeds = app.verticalSearch.listSeeds();
  const pages = fixture.cases.map(item => {
    const publication = publications.find(page => page.url === item.url);
    if (!publication?.result) return { id: item.id, url: item.url, status: publication?.status ?? 'launch_failed', error: publication?.error ?? run.jobs.find(j => j.seedId === seeds.find(s => s.url === item.url)?.id)?.error ?? null };
    const page = publication.result;
    writeFileSync(join(output, 'pages', `${item.id}.md`), page.contentMarkdown);
    return { id: item.id, url: item.url, status: publication.status, finalUrl: page.finalUrl, title: page.title,
      characters: page.contentMarkdown.length, contentHash: page.contentHash, fetchedAt: page.fetchedAt,
      completeness: page.completeness, validation: page.validation, evidence: page.evidence };
  });
  const queries = [];
  for (const item of fixture.cases) {
    const page = pages.find(p => p.id === item.id);
    const expectedUrl = page.finalUrl ?? item.url;
    app.verticalSearch.setQueryJudgment(item.question, [expectedUrl]);
    const result = { ...item, expectedUrl, indexed: !!page.finalUrl };
    for (const [key, query] of [['raw', item.question], ['agent', item.agentQuery]]) {
      const started = performance.now();
      const response = await app.search.searchWeb({ query, source: 'local', limit: 10 });
      const urls = response.results.map(r => r.url);
      const index = urls.indexOf(expectedUrl);
      result[key] = { rank: index < 0 ? null : index + 1, latencyMs: performance.now() - started,
        results: response.results, trace: response.trace };
    }
    queries.push(result);
  }
  const rawEvaluation = await app.verticalSearch.evaluateQuerySet();
  const metrics = Object.fromEntries(['raw', 'agent'].map(key => [key, {
    hitAt10: queries.filter(q => q[key].rank !== null).length / queries.length,
    mrrAt10: queries.reduce((sum, q) => sum + (q[key].rank ? 1 / q[key].rank : 0), 0) / queries.length,
  }]));
  const collectionStatus = pages.every(p => p.finalUrl) ? 'complete' : 'partial';
  const report = { collectionStatus, description: fixture.description, evaluatedAt: new Date().toISOString(), fixtureHash,
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    trackedDiffHash: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'])).digest('hex'),
    runnerHash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    workingTreeDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    dataDir: state.dataDir, run, searchStatus: app.search.status(), pages, queries, metrics, rawEvaluation };
  save(join(output, 'report.json'), report);
  const lines = ['# Crawlume 文档试用结果', '', `评测时间：${report.evaluatedAt}`, '', fixture.description, '',
    `采集状态：${collectionStatus}（任务状态 ${run.status}）；索引页数：${report.searchStatus.localDocuments}；计划问题：${queries.length}。`, '',
    '| 查询方式 | Hit@10 | MRR@10 |', '| --- | ---: | ---: |',
    ...Object.entries(metrics).map(([key, m]) => `| ${key === 'raw' ? '中文问题原文' : '预先编写的英文检索词'} | ${(m.hitAt10 * 100).toFixed(1)}% | ${m.mrrAt10.toFixed(3)} |`), '',
    '每题只有一个预设目标页，Recall@10 与 Hit@10 相同；其他相关页未被穷举。英文检索词在采集前冻结，不代表自动查询改写能力。', '',
    '| ID | 问题 | 采集 | 中文排名 | 英文词排名 | 原文 |', '| --- | --- | --- | ---: | ---: | --- |',
    ...queries.map(q => `| ${q.id} | ${q.question} | ${q.indexed ? '已索引' : '失败'} | ${q.raw.rank ?? '未命中'} | ${q.agent.rank ?? '未命中'} | [官方页面](${q.expectedUrl}) |`), '',
    '逐页正文位于 pages/；完整来源、验证结果、错误、消耗与查询结果位于 report.json。内容质量需要人工核对，valid 不代表事实或正文完整性已获独立证明。', ''];
  writeFileSync(join(output, 'report.md'), lines.join('\n'));
  console.log(JSON.stringify({ report: join(output, 'report.md'), status: collectionStatus, documents: report.searchStatus.localDocuments, metrics }, null, 2));
  if (pages.some(p => !p.finalUrl)) process.exitCode = 2;
} finally {
  await app.close();
}
