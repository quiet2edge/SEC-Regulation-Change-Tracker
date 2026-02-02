import { request } from 'undici';
import crypto from 'node:crypto';
import { load as cheerioLoad } from 'cheerio';

export function normalizeCik(cik) {
  const s = String(cik).replace(/\D/g, '');
  return s.padStart(10, '0');
}

export function cikToIntString(cikPadded10) {
  // SEC archive path uses CIK without leading zeros
  return String(parseInt(cikPadded10, 10));
}

export function accessionNoNoDashes(accession) {
  return String(accession).replace(/-/g, '');
}

export function isAmendmentForm(form) {
  // Most amendments appear as /A suffix (e.g., 10-K/A, S-1/A). Some forms may have 'A' variants.
  return /\/A\b/.test(form);
}

export function baseForm(form) {
  return String(form).replace(/\s+/g, ' ').replace(/\/A\b/g, '').trim();
}

export function parseISODateOrEmpty(s) {
  const v = (s || '').trim();
  if (!v) return null;
  // basic validation YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function inDateRange(isoDateStr, startDate, endDate) {
  if (!isoDateStr) return false;
  const d = new Date(isoDateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  if (startDate && d < startDate) return false;
  if (endDate && d > endDate) return false;
  return true;
}

export async function httpGetJson(url, { userAgent, headers = {}, timeoutMs = 30000 } = {}) {
  const res = await request(url, {
    method: 'GET',
    headers: {
      'User-Agent': userAgent,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      ...headers,
    },
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new Error(`HTTP ${res.statusCode} for ${url}: ${body.slice(0, 500)}`);
  }
  const text = await res.body.text();
  return JSON.parse(text);
}

export async function httpGetText(url, { userAgent, headers = {}, timeoutMs = 45000 } = {}) {
  const res = await request(url, {
    method: 'GET',
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,text/plain,*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      ...headers,
    },
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new Error(`HTTP ${res.statusCode} for ${url}: ${body.slice(0, 500)}`);
  }
  return await res.body.text();
}

export function htmlToText(html) {
  const $ = cheerioLoad(html);
  $('script,style,noscript').remove();
  const txt = $.text();
  return txt.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

export function extractSectionByItem(text, { startPatterns, endPatterns, maxChars = 12000 }) {
  // Heuristic: find earliest start pattern, then find next end pattern after it.
  const lower = text.toLowerCase();
  let startIdx = -1;
  for (const p of startPatterns) {
    const idx = lower.search(p);
    if (idx !== -1 && (startIdx === -1 || idx < startIdx)) startIdx = idx;
  }
  if (startIdx === -1) return '';

  let endIdx = -1;
  const sub = lower.slice(startIdx + 1);
  for (const p of endPatterns) {
    const idx = sub.search(p);
    if (idx !== -1) {
      const candidate = startIdx + 1 + idx;
      if (candidate > startIdx && (endIdx === -1 || candidate < endIdx)) endIdx = candidate;
    }
  }
  const slice = endIdx === -1 ? text.slice(startIdx) : text.slice(startIdx, endIdx);
  return slice.slice(0, maxChars).trim();
}

export function hashText(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

export function heuristicChangeSummary({ form, filingDate, isAmendment, riskFactors, financialStatements }) {
  const parts = [];
  parts.push(isAmendment ? `Amendment detected (${form})` : `New filing detected (${form})`);
  if (filingDate) parts.push(`Filing date: ${filingDate}`);
  if (riskFactors) parts.push(`Risk Factors excerpt length: ${riskFactors.length} chars`);
  if (financialStatements) parts.push(`Financial Statements excerpt length: ${financialStatements.length} chars`);
  return parts.join(' • ');
}
