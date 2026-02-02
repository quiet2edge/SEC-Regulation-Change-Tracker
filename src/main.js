import { Actor } from 'apify';
import { Parser } from 'json2csv';
import {
  parseISODateOrEmpty,
  heuristicChangeSummary,
} from './utils.js';
import { summarizeWithOpenAI } from './ai.js';
import { resolveTargets, scanCompanies, fetchCompanySubmissions, getRecentFilings } from './sec.js';
import { baseForm, isAmendmentForm } from './utils.js';

Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const kvStore = await Actor.openKeyValueStore();
  const dataset = await Actor.openDataset();

  // Persistent state
  const stateKey = 'STATE.json';
  const state = (await kvStore.getValue(stateKey)) || {
    lastSuccessfulRunAt: null,
    seen: {},          // key: cik:accession -> firstSeenAt
    fingerprints: {},  // key: cik:accession -> fingerprint hash
  };

  const runStartedAt = new Date().toISOString();

  const userAgent = String(input.userAgent || '').trim();
  if (!userAgent) throw new Error('Input validation: userAgent is required.');

  const forms = (input.forms || []).map(f => String(f).trim()).filter(Boolean);
  const formsSet = new Set(forms);

  const startDate = parseISODateOrEmpty(input?.dateRange?.startDate);
  const endDate = parseISODateOrEmpty(input?.dateRange?.endDate);

  const backfill = Boolean(input.backfill);
  const backfillDays = Number.isFinite(input.backfillDays) ? Number(input.backfillDays) : 30;

  const outputFormats = new Set((input.outputFormats || ['json']).map(s => String(s).toLowerCase()));
  const parseSections = input?.enrich?.parseSections !== false;
  const aiSummarize = input?.enrich?.aiSummarize !== false;
  const openaiApiKey = (input?.enrich?.openaiApiKey || '').trim();
  const aiModel = String(input?.enrich?.aiModel || 'gpt-4o-mini');
  const maxSectionChars = Number(input?.enrich?.maxSectionChars || 12000);
  const maxCompanies = Number(input.maxCompanies || 200);
  const maxFilingsPerCompany = Number(input.maxFilingsPerCompany || 200);
  const requestConcurrency = Number(input.requestConcurrency || 4);

  // Determine effective start bound if first run and backfill requested without explicit dateRange
  let effectiveStartDate = startDate;
  let effectiveEndDate = endDate;

  const firstRun = !state.lastSuccessfulRunAt;

  if (firstRun && backfill && !startDate && !endDate) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - backfillDays);
    effectiveStartDate = d;
  }

  // If first run and backfill is false and no date range, we only treat filings newer than now as "new"
  // (meaning: we don't dump historic filings into results)
  const suppressHistory = firstRun && !backfill && !startDate && !endDate;

  const targetsResolved = await resolveTargets({
    userAgent,
    kvStore,
    targets: input.targets || {},
    maxCompanies,
  });

  if (!targetsResolved.length) {
    await kvStore.setValue('REPORT.json', {
      runStartedAt,
      message: 'No targets provided. Provide targets.tickers and/or targets.ciks.',
    });
    Actor.log.warning('No targets provided. Exiting.');
    return;
  }

  // Scan filings and detect new/amended/updated items
  let detected = await scanCompanies({
    targetsResolved,
    userAgent,
    formsSet,
    startDate: effectiveStartDate,
    endDate: effectiveEndDate,
    state,
    maxFilingsPerCompany,
    parseSections,
    maxSectionChars,
    requestConcurrency,
  });

  // If we want to suppress history on first run, filter to only items whose filingDate >= runStartedAt date
  if (suppressHistory) {
    const runDate = new Date(runStartedAt.slice(0,10) + 'T00:00:00Z');
    detected = detected.filter(x => {
      if (!x.filingDate) return false;
      const d = new Date(x.filingDate + 'T00:00:00Z');
      return !Number.isNaN(d.getTime()) && d >= runDate;
    });
  }

  // Enrich with AI summaries, and for amendments try to compare to latest prior base-form filing
  const withSummaries = [];
  for (const item of detected) {
    let aiSummary = null;
    let priorAccession = null;
    let priorFilingUrl = null;

    if (item.isAmendment) {
      try {
        const subs = await fetchCompanySubmissions({ cik10: item.cik, userAgent });
        const recent = getRecentFilings(subs);

        const targetBase = baseForm(item.form);
        // Find most recent non-amendment of same base form with earlier filingDate
        const prior = recent.find(f => {
          const form = (f.form || '').replace(/^13D$/i, 'SC 13D').replace(/^13G$/i, 'SC 13G');
          if (baseForm(form) !== targetBase) return false;
          if (isAmendmentForm(form)) return false;
          if (!f.filingDate || !item.filingDate) return false;
          return f.filingDate < item.filingDate;
        });

        if (prior) {
          priorAccession = prior.accessionNumber;
          // We don't fetch the whole prior doc here to keep runtime down; AI prompt uses section excerpts if available.
          priorFilingUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(item.cik,10)}/${priorAccession.replace(/-/g,'')}/`;
        }
      } catch (e) {
        // ignore
      }
    }

    const heuristic = heuristicChangeSummary({
      form: item.form,
      filingDate: item.filingDate,
      isAmendment: item.isAmendment,
      riskFactors: item.sections?.riskFactors || '',
      financialStatements: item.sections?.financialStatements || '',
    });

    if (aiSummarize && openaiApiKey) {
      const prompt = buildPrompt({
        item,
        heuristic,
        priorAccession,
        priorFilingUrl,
      });

      try {
        aiSummary = await summarizeWithOpenAI({
          apiKey: openaiApiKey,
          model: aiModel,
          prompt,
        });
      } catch (e) {
        Actor.log.warning(`OpenAI summarize failed for ${item.cik}:${item.accessionNumber}: ${e.message}`);
      }
    }

    withSummaries.push({
      ...item,
      priorAccessionNumber: priorAccession,
      priorFilingUrl,
      heuristicSummary: heuristic,
      aiSummary,
      runStartedAt,
    });
  }

  // Write dataset
  for (const row of withSummaries) {
    await dataset.pushData(row);
  }

  // Update state: mark all scanned changes as seen & store fingerprints
  const nowIso = new Date().toISOString();
  for (const row of withSummaries) {
    const key = `${row.cik}:${row.accessionNumber}`;
    state.seen[key] = state.seen[key] || nowIso;
    state.fingerprints[key] = row.fingerprint || state.fingerprints[key] || null;
  }

  // Keep state bounded (simple LRU-ish by oldest firstSeenAt)
  state = pruneState(state, 20000);

  // Create report
  const report = buildReport(withSummaries, { runStartedAt, firstRun, backfill, effectiveStartDate, effectiveEndDate, suppressHistory });
  await kvStore.setValue('REPORT.json', report);
  await kvStore.setValue('REPORT.md', reportToMarkdown(report));

  // CSV export
  if (outputFormats.has('csv')) {
    const fields = [
      'runStartedAt','changeType','ticker','cik','companyName','form','filingDate','reportDate','accessionNumber',
      'isAmendment','filingUrl','primaryDocument','items','fileNumber','acceptanceDateTime',
      'priorAccessionNumber','priorFilingUrl','heuristicSummary','aiSummary',
      'sections.riskFactors','sections.financialStatements',
    ];
    const parser = new Parser({ fields, unwind: false });
    const csv = parser.parse(withSummaries);
    await kvStore.setValue('OUTPUT.csv', csv, { contentType: 'text/csv; charset=utf-8' });
  }

  // Save final state
  state.lastSuccessfulRunAt = nowIso;
  await kvStore.setValue(stateKey, state);

  Actor.log.info(`Done. Detected ${withSummaries.length} change(s). Report saved to REPORT.json / REPORT.md.`);
});

function pruneState(state, maxKeys) {
  const entries = Object.entries(state.seen || {});
  if (entries.length <= maxKeys) return state;

  entries.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const toRemove = entries.slice(0, Math.max(0, entries.length - maxKeys));

  for (const [key] of toRemove) {
    delete state.seen[key];
    delete state.fingerprints[key];
  }
  return state;
}

function buildPrompt({ item, heuristic, priorAccession, priorFilingUrl }) {
  const risk = (item.sections?.riskFactors || '').slice(0, 8000);
  const fin = (item.sections?.financialStatements || '').slice(0, 8000);

  return [
    `You are an analyst summarizing changes in SEC filings for monitoring purposes.`,
    ``,
    `Task: Summarize what is new or changed in this filing (and if it is an amendment, highlight what changed vs the prior version).`,
    `Return: (1) 3-7 bullet key changes, (2) 1 short risk note, (3) 1 short "why it matters" line.`,
    ``,
    `Metadata:`,
    `- Company: ${item.companyName} (${item.ticker || 'n/a'}) CIK ${item.cik}`,
    `- Form: ${item.form} (${item.changeType})`,
    `- Filing date: ${item.filingDate || 'n/a'}`,
    `- Accession: ${item.accessionNumber}`,
    `- Filing URL: ${item.filingUrl || 'n/a'}`,
    priorAccession ? `- Prior (best guess): ${priorAccession} ${priorFilingUrl || ''}` : ``,
    ``,
    `Heuristic context: ${heuristic}`,
    ``,
    `Extracted Risk Factors (excerpt):`,
    risk ? risk : '(none)',
    ``,
    `Extracted Financial Statements (excerpt):`,
    fin ? fin : '(none)',
  ].filter(Boolean).join('\n');
}

function buildReport(rows, meta) {
  const byType = { new: 0, amendment: 0, update: 0 };
  const byForm = {};
  const byCompany = {};
  for (const r of rows) {
    byType[r.changeType] = (byType[r.changeType] || 0) + 1;
    byForm[r.form] = (byForm[r.form] || 0) + 1;
    const key = `${r.companyName} (${r.ticker || r.cik})`;
    byCompany[key] = (byCompany[key] || 0) + 1;
  }

  return {
    runStartedAt: meta.runStartedAt,
    firstRun: meta.firstRun,
    backfill: meta.backfill,
    suppressHistory: meta.suppressHistory,
    effectiveDateRange: {
      startDate: meta.effectiveStartDate ? meta.effectiveStartDate.toISOString().slice(0,10) : '',
      endDate: meta.effectiveEndDate ? meta.effectiveEndDate.toISOString().slice(0,10) : '',
    },
    totals: {
      changesDetected: rows.length,
      byType,
      byForm,
      byCompany,
    },
    topChanges: rows.slice(0, 50).map(r => ({
      changeType: r.changeType,
      companyName: r.companyName,
      ticker: r.ticker,
      cik: r.cik,
      form: r.form,
      filingDate: r.filingDate,
      accessionNumber: r.accessionNumber,
      filingUrl: r.filingUrl,
      aiSummary: r.aiSummary,
      heuristicSummary: r.heuristicSummary,
    })),
  };
}

function reportToMarkdown(report) {
  const lines = [];
  lines.push(`# SEC Filing Change Report`);
  lines.push(`- Run started: ${report.runStartedAt}`);
  lines.push(`- First run: ${report.firstRun}`);
  lines.push(`- Backfill: ${report.backfill}`);
  if (report.effectiveDateRange?.startDate || report.effectiveDateRange?.endDate) {
    lines.push(`- Date range: ${report.effectiveDateRange.startDate || '…'} to ${report.effectiveDateRange.endDate || '…'}`);
  }
  lines.push(``);
  lines.push(`## Totals`);
  lines.push(`- Changes detected: **${report.totals.changesDetected}**`);
  lines.push(`- By type: ${Object.entries(report.totals.byType).map(([k,v]) => `${k}=${v}`).join(', ')}`);
  lines.push(``);
  lines.push(`## Top changes (up to 50)`);
  for (const c of report.topChanges || []) {
    lines.push(`- **${c.changeType.toUpperCase()}** ${c.companyName} (${c.ticker || 'n/a'}) • ${c.form} • ${c.filingDate || 'n/a'} • ${c.accessionNumber}`);
    if (c.aiSummary) lines.push(`  - AI: ${c.aiSummary.replace(/\n/g,' ')}`);
    else if (c.heuristicSummary) lines.push(`  - Note: ${c.heuristicSummary}`);
    if (c.filingUrl) lines.push(`  - URL: ${c.filingUrl}`);
  }
  lines.push('');
  return lines.join('\n');
}
