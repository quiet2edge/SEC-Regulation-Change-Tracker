import pLimit from 'p-limit';
import { httpGetJson, httpGetText, normalizeCik, cikToIntString, accessionNoNoDashes, isAmendmentForm, baseForm, htmlToText, extractSectionByItem, hashText } from './utils.js';

const SEC_TICKER_CIK_URL = 'https://www.sec.gov/files/company_tickers.json';

export async function getTickerCikMap({ userAgent, kvStore }) {
  // Cache ticker->cik map in the default KV store for ~24h (best-effort).
  const cacheKey = 'TICKER_CIK_MAP';
  const cached = await kvStore.getValue(cacheKey);
  const now = Date.now();

  if (cached?.fetchedAt && (now - cached.fetchedAt) < 24 * 60 * 60 * 1000 && cached?.map) {
    return cached.map;
  }

  const data = await httpGetJson(SEC_TICKER_CIK_URL, { userAgent });
  // company_tickers.json is an object keyed by index with { cik_str, ticker, title }
  const map = {};
  for (const k of Object.keys(data)) {
    const row = data[k];
    if (!row?.ticker || row?.cik_str == null) continue;
    map[String(row.ticker).toUpperCase()] = String(row.cik_str);
  }
  await kvStore.setValue(cacheKey, { fetchedAt: now, map });
  return map;
}

export async function resolveTargets({ userAgent, kvStore, targets, maxCompanies }) {
  const tickers = (targets?.tickers || []).map(t => String(t).trim().toUpperCase()).filter(Boolean);
  const ciks = (targets?.ciks || []).map(c => String(c).trim()).filter(Boolean);

  const tickerMap = tickers.length ? await getTickerCikMap({ userAgent, kvStore }) : {};
  const out = [];
  for (const t of tickers) {
    const cik = tickerMap[t];
    if (cik) out.push({ ticker: t, cik });
  }
  for (const c of ciks) {
    out.push({ ticker: null, cik: c });
  }

  // de-dupe by cik
  const seen = new Set();
  const deduped = [];
  for (const item of out) {
    const cik10 = normalizeCik(item.cik);
    if (seen.has(cik10)) continue;
    seen.add(cik10);
    deduped.push({ ...item, cik: cik10 });
    if (deduped.length >= maxCompanies) break;
  }
  return deduped;
}

export async function fetchCompanySubmissions({ cik10, userAgent }) {
  const url = `https://data.sec.gov/submissions/CIK${cik10}.json`;
  return await httpGetJson(url, { userAgent });
}

export function getRecentFilings(submissions) {
  // submissions.filings.recent is the easiest set; arrays aligned by index
  const recent = submissions?.filings?.recent;
  if (!recent?.accessionNumber) return [];
  const n = recent.accessionNumber.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      accessionNumber: recent.accessionNumber[i],
      filingDate: recent.filingDate?.[i] || '',
      reportDate: recent.reportDate?.[i] || '',
      acceptanceDateTime: recent.acceptanceDateTime?.[i] || '',
      act: recent.act?.[i] || '',
      form: recent.form?.[i] || '',
      fileNumber: recent.fileNumber?.[i] || '',
      filmNumber: recent.filmNumber?.[i] || '',
      items: recent.items?.[i] || '',
      size: recent.size?.[i] || null,
      isXBRL: recent.isXBRL?.[i] || 0,
      isInlineXBRL: recent.isInlineXBRL?.[i] || 0,
      primaryDocument: recent.primaryDocument?.[i] || '',
      primaryDocDescription: recent.primaryDocDescription?.[i] || '',
    });
  }
  return out;
}

export async function fetchFilingIndex({ cik10, accessionNumber, userAgent }) {
  const cikInt = cikToIntString(cik10);
  const accNo = accessionNoNoDashes(accessionNumber);
  const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNo}/index.json`;
  return await httpGetJson(url, { userAgent });
}

export function pickPrimaryDoc(indexJson) {
  const items = indexJson?.directory?.item || [];
  // Prefer .htm/.html, otherwise .txt
  const html = items.find(x => /\.html?$/i.test(x.name));
  if (html) return html.name;
  const txt = items.find(x => /\.txt$/i.test(x.name));
  if (txt) return txt.name;
  return items[0]?.name || null;
}

export async function fetchFilingText({ cik10, accessionNumber, docName, userAgent }) {
  const cikInt = cikToIntString(cik10);
  const accNo = accessionNoNoDashes(accessionNumber);
  const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNo}/${docName}`;
  const raw = await httpGetText(url, { userAgent });
  if (/\.html?$/i.test(docName)) return htmlToText(raw);
  return raw;
}

export function parseKeySections({ form, text, maxSectionChars }) {
  const f = String(form || '').toUpperCase();

  // Risk Factors is common in 10-K (Item 1A) and 10-Q (Item 1A / Part II)
  const riskFactors = extractSectionByItem(text, {
    startPatterns: [
      /\bitem\s+1a\.?\s+risk\s+factors\b/i,
      /\brisk\s+factors\b/i,
    ],
    endPatterns: [
      /\bitem\s+1b\b/i,
      /\bitem\s+2\b/i,
      /\bpart\s+ii\b/i,
    ],
    maxChars: maxSectionChars,
  });

  // Financial statements usually around Item 8 (10-K) or Part I Item 1 (10-Q)
  const financialStatements = extractSectionByItem(text, {
    startPatterns: [
      /\bitem\s+8\.?\s+financial\s+statements\b/i,
      /\bitem\s+1\.?\s+financial\s+statements\b/i,
      /\bfinancial\s+statements\s+and\s+supplementary\s+data\b/i,
      /\bconsolidated\s+financial\s+statements\b/i,
    ],
    endPatterns: [
      /\bitem\s+9\b/i,
      /\bitem\s+2\b/i,
      /\bitem\s+3\b/i,
      /\bmanagement'?s\s+discussion\b/i,
    ],
    maxChars: maxSectionChars,
  });

  return { riskFactors, financialStatements };
}

export function filingFingerprint({ accessionNumber, form, filingDate, riskFactors, financialStatements }) {
  return hashText(JSON.stringify({
    accessionNumber,
    form,
    filingDate,
    riskHash: hashText(riskFactors || ''),
    finHash: hashText(financialStatements || ''),
  }));
}

export async function scanCompanies({
  targetsResolved,
  userAgent,
  formsSet,
  startDate,
  endDate,
  state,
  maxFilingsPerCompany,
  parseSections,
  maxSectionChars,
  requestConcurrency,
}) {
  const limit = pLimit(requestConcurrency);
  const results = [];

  await Promise.all(targetsResolved.map(t => limit(async () => {
    const subs = await fetchCompanySubmissions({ cik10: t.cik, userAgent });
    const companyName = subs?.name || '';
    const tickers = subs?.tickers || [];
    const ticker = t.ticker || tickers?.[0] || null;

    const recent = getRecentFilings(subs).slice(0, maxFilingsPerCompany);

    for (const filing of recent) {
      if (!filing.form) continue;

      // Normalize form names for SC 13D/13G variants (user may input 13D/13G, but EDGAR often uses SC 13D / SC 13G)
      const normalizedForm = filing.form.replace(/^13D$/i, 'SC 13D').replace(/^13G$/i, 'SC 13G');

      // Allow matches if user asked for 13D/13G shorthand
      const okForm = formsSet.has(normalizedForm) ||
        (normalizedForm === 'SC 13D' && formsSet.has('13D')) ||
        (normalizedForm === 'SC 13G' && formsSet.has('13G'));

      if (!okForm) continue;

      if (startDate || endDate) {
        if (!inDateRangeSafe(filing.filingDate, startDate, endDate)) continue;
      }

      const key = `${t.cik}:${filing.accessionNumber}`;
      const isAmend = isAmendmentForm(normalizedForm);

      // Decide whether this is "new" vs "seen"
      const seenEntry = state?.seen?.[key];
      const priorFingerprint = state?.fingerprints?.[key];

      // If no date range: treat as change if not seen since last run OR fingerprint changed
      // If date range provided and backfilling: still avoid duplicates within a run by 'seen' state.
      const shouldConsider = !seenEntry;

      // We'll enrich & fingerprint to detect updates even for same accession in rare cases.
      let sections = { riskFactors: '', financialStatements: '' };
      let fingerprint = null;
      let filingUrl = null;
      let docName = filing.primaryDocument || null;

      try {
        const indexJson = await fetchFilingIndex({ cik10: t.cik, accessionNumber: filing.accessionNumber, userAgent });
        if (!docName) docName = pickPrimaryDoc(indexJson);
        filingUrl = `https://www.sec.gov/Archives/edgar/data/${cikToIntString(t.cik)}/${accessionNoNoDashes(filing.accessionNumber)}/${docName || ''}`;

        if (parseSections && docName) {
          const text = await fetchFilingText({ cik10: t.cik, accessionNumber: filing.accessionNumber, docName, userAgent });
          sections = parseKeySections({ form: normalizedForm, text, maxSectionChars });
          fingerprint = filingFingerprint({
            accessionNumber: filing.accessionNumber,
            form: normalizedForm,
            filingDate: filing.filingDate,
            riskFactors: sections.riskFactors,
            financialStatements: sections.financialStatements,
          });
        } else {
          fingerprint = filingFingerprint({
            accessionNumber: filing.accessionNumber,
            form: normalizedForm,
            filingDate: filing.filingDate,
            riskFactors: '',
            financialStatements: '',
          });
        }
      } catch (e) {
        // Keep going: we can still record basic metadata
        fingerprint = filingFingerprint({
          accessionNumber: filing.accessionNumber,
          form: normalizedForm,
          filingDate: filing.filingDate,
          riskFactors: '',
          financialStatements: '',
        });
      }

      const isUpdate = !!seenEntry && priorFingerprint && fingerprint && priorFingerprint !== fingerprint;

      if (shouldConsider || isUpdate) {
        results.push({
          cik: t.cik,
          ticker,
          companyName,
          form: normalizedForm,
          baseForm: baseForm(normalizedForm),
          isAmendment: isAmend,
          accessionNumber: filing.accessionNumber,
          filingDate: filing.filingDate || '',
          reportDate: filing.reportDate || '',
          primaryDocument: docName || filing.primaryDocument || '',
          filingUrl,
          items: filing.items || '',
          fileNumber: filing.fileNumber || '',
          acceptanceDateTime: filing.acceptanceDateTime || '',
          sections,
          fingerprint,
          changeType: isUpdate ? 'update' : (isAmend ? 'amendment' : 'new'),
        });
      }
    }
  })));

  return results;
}

function inDateRangeSafe(iso, start, end) {
  if (!iso) return false;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}
