// Run with: node tests/xss-paper-score.pw.mjs
// (also wired up as `npm run test:e2e`)
//
// Covers audit finding #3 (HIGH): renderPaperResultInstructor() and
// renderPaperResultWriter() interpolated af.score/lv.score/ai.score
// directly into innerHTML without esc(), unlike every other score field
// in the app. Since JSON.parse() never validates that the AI's response
// actually matches the schema it was asked to follow, a non-numeric value
// in one of these fields (e.g. from a successful prompt injection via the
// submitted paper text) would render as live HTML instead of inert text.
//
// This starts a real local static server, loads the real index.html in a
// real browser, mocks /api/analyze to return a script-injecting payload
// in place of a numeric score, and asserts the payload never executes —
// for both Instructor and Writer render modes, and for all three
// now-fixed fields.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8931;

function startServer() {
  const server = createServer(async (req, res) => {
    const filePath = path.join(ROOT, req.url === '/' ? '/index.html' : req.url);
    try {
      const data = await readFile(filePath);
      res.writeHead(200);
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

const XSS_PAYLOAD = '<img src=x onerror="window.__xssFired=(window.__xssFired||0)+1">';

const maliciousMock = {
  assignment_fit: { score: XSS_PAYLOAD, summary: 'ok', unaddressed_parts: [] },
  textbook_alignment: { textbook_recognized: false, confidence_note: '', findings: [] },
  level_voice_consistency: { score: XSS_PAYLOAD, findings: [], notable_shifts: [] },
  ai_likelihood_indicators: { score: XSS_PAYLOAD, findings: [] },
  fact_check: { claims: [] },
  citation_check: { detected_style: 'APA', style_confidence: 'high', issues: [] },
  overall_verdict: 'looks fine'
};

async function testMode(browser, mode) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await context.addInitScript(() => {
    localStorage.setItem('cf_ob', 'true');
    localStorage.setItem('cf_age_confirmed', 'true');
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.route('**/api/analyze', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ content: [{ text: JSON.stringify(maliciousMock) }] })
  }));

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.evaluate(() => nav('paper'));
  await page.waitForTimeout(150);
  if (mode === 'writer') {
    await page.click('#paperModeWriter');
    await page.waitForTimeout(100);
  }
  await page.fill('#paperText', 'irrelevant paper text for this test');
  await page.click('#pg-paper .btn-p');
  await page.waitForTimeout(800);

  const xssFireCount = await page.evaluate(() => window.__xssFired || 0);
  const scoreTagText = await page.evaluate(() =>
    [...document.querySelectorAll('.card-hd-tag')].map((t) => t.textContent).join(' | ')
  );
  const scoreTagHTML = await page.evaluate(() =>
    [...document.querySelectorAll('.card-hd-tag')].map((t) => t.innerHTML).join(' | ')
  );

  await context.close();
  return { xssFireCount, scoreTagText, scoreTagHTML, pageErrors };
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  let failed = false;

  try {
    for (const mode of ['instructor', 'writer']) {
      const result = await testMode(browser, mode);
      console.log(`--- ${mode} mode ---`);
      console.log('XSS fired:', result.xssFireCount, '(expect 0)');
      console.log('score tag text (should show the payload as literal text, not run it):', result.scoreTagText.slice(0, 200));
      console.log('score tag HTML (should show &lt;img ...&gt;, not a live <img> tag):', result.scoreTagHTML.slice(0, 200));

      try {
        assert.equal(result.xssFireCount, 0, `${mode}: XSS payload executed`);
        assert.ok(!result.scoreTagHTML.includes('<img'), `${mode}: raw <img> tag present in DOM instead of escaped text`);
        assert.ok(result.scoreTagText.includes('<img'), `${mode}: expected the literal payload text to be visible/escaped, not stripped`);
        console.log(`${mode}: PASS`);
      } catch (e) {
        console.error(`${mode}: FAIL —`, e.message);
        failed = true;
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failed) {
    console.error('\nXSS TEST SUITE: FAILED');
    process.exit(1);
  }
  console.log('\nXSS TEST SUITE: ALL PASSED');
}

main();
