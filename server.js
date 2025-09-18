// server.js (force download + manual fetch fallback for real PDFs)

const express = require('express');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const puppeteer = require('puppeteer'); 

puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(AdblockerPlugin({ blockTrackers: true }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'dev-key-change-me';
const REFERER = process.env.REFERER || 'https://www.bseindia.com/';

const app = express();
app.use(express.json({ limit: '1mb' }));

let browser = null;
let isBusy = false;
const queue = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureBrowser() {
  if (browser) return;
  browser = await puppeteerExtra.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-pdfjs' // disable built-in PDF viewer
    ],
    defaultViewport: { width: 1280, height: 800 }
  });

  browser.on('disconnected', () => {
    console.warn('Browser disconnected, clearing reference.');
    browser = null;
  });
}

async function preparePage(page) {
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9'
  });

  // ✅ Force Chromium to download PDFs instead of viewing them
  try {
    await page._client().send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: '/tmp'
    });
  } catch (e) {
    console.warn('Download behavior setup failed (non-fatal):', e.message);
  }
}

async function processTask(task, res) {
  try {
    const buffer = await task();
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': buffer.length,
      'Content-Disposition': 'attachment; filename="file.pdf"'
    });
    res.send(buffer);
  } catch (err) {
    console.error('Error fetching PDF:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'failed to fetch pdf', details: err.message || String(err) });
  } finally {
    isBusy = false;
    if (queue.length) {
      const next = queue.shift();
      isBusy = true;
      setTimeout(() => processTask(next.task, next.res), 600);
    }
  }
}

app.post('/download', async (req, res) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'missing or invalid API key' });
  }
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'missing url in JSON body' });
  }

  const task = async () => {
    await ensureBrowser();
    const page = await browser.newPage();

    let pdfBuffer = null;

    try {
      await preparePage(page);

      page.on('response', async (resp) => {
        try {
          const req = resp.request();
          const headers = resp.headers();
          const ct = (headers['content-type'] || '').toLowerCase();
          console.log(`[DEBUG] URL: ${req.url()} | Type: ${ct} | Status: ${resp.status()}`);

          // Candidate PDF
          if (req.url().toLowerCase().includes('.pdf') || ct.includes('pdf')) {
            let b = null;
            try {
              b = await resp.buffer();
            } catch (e) {
              console.warn(`⚠️ Failed to buffer response from ${req.url()}:`, e.message);
            }

            if (b && b.length > 100 && b.toString('utf8', 0, 8).startsWith('%PDF-')) {
              pdfBuffer = b;
              console.log(`✅ Captured REAL PDF from ${req.url()} (length ${b.length})`);
            } else if (b && b.length > 0) {
              console.warn(`⚠️ Fake/stub PDF from ${req.url()} (length ${b.length}) — retrying with manual fetch`);

              // 🔥 Manual fetch inside browser context
              const base64 = await page.evaluate(async (pdfUrl) => {
                const res = await fetch(pdfUrl, { credentials: 'omit' });
                const buf = await res.arrayBuffer();
                return btoa(String.fromCharCode(...new Uint8Array(buf)));
              }, req.url());

              if (base64) {
                const raw = Buffer.from(base64, 'base64');
                if (raw.toString('utf8', 0, 8).startsWith('%PDF-')) {
                  pdfBuffer = raw;
                  console.log(`✅ Captured REAL PDF via manual fetch (length ${raw.length})`);
                } else {
                  console.warn('⚠️ Manual fetch still did not return a valid PDF');
                }
              }
            }
          }
        } catch (e) {
          console.warn('Response handler error:', e.message);
        }
      });

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await sleep(5000);

      if (pdfBuffer) return pdfBuffer;

      throw new Error('No real PDF captured (even after manual fetch)');
    } finally {
      await page.close().catch(()=>{});
    }
  };

  if (isBusy) {
    queue.push({ task, res });
    return;
  }
  isBusy = true;
  processTask(task, res);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', browserUp: !!browser, queueLength: queue.length });
});

app.listen(PORT, async () => {
  console.log(`Listening on port ${PORT}`);
  try {
    await ensureBrowser();
    console.log('Browser launched (warm).');
  } catch (err) {
    console.warn('Browser failed to start on boot; will start lazily on first request.', err.message);
  }
});
