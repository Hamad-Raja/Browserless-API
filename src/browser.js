import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config } from './config.js';

if (config.enableStealth) {
  puppeteer.use(StealthPlugin());
}

const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 5000;
const activeBrowsers = new Map();

function browserPid(browser) {
  try {
    return browser?.process?.()?.pid ?? null;
  } catch {
    return null;
  }
}

function forceKillBrowserProcess(browser, log = undefined) {
  const childProcess = browser?.process?.();
  const pid = childProcess?.pid;

  if (!childProcess || !pid || childProcess.killed) {
    return false;
  }

  try {
    childProcess.kill('SIGKILL');
    log?.warn?.({ chromium_pid: pid }, 'Force killed Chromium process after close timeout');
    return true;
  } catch (error) {
    log?.warn?.({ err: error, chromium_pid: pid }, 'Failed to force kill Chromium process');
    return false;
  }
}

function closeWithTimeout(browser, timeoutMs) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`browser_close_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
    timeoutId.unref?.();
  });

  return Promise.race([browser.close(), timeoutPromise])
    .finally(() => clearTimeout(timeoutId));
}

export function getBrowserRuntimeState() {
  const entries = Array.from(activeBrowsers.values());

  return {
    activeTrackedBrowsers: entries.length,
    activeBrowserPids: entries
      .map((entry) => entry.pid)
      .filter((pid) => Number.isInteger(pid)),
    oldestBrowserAgeMs: entries.length
      ? Math.max(...entries.map((entry) => Date.now() - entry.startedAt))
      : 0
  };
}

export function trackBrowser(browser, { jobId = undefined, log = undefined, startedAt = Date.now() } = {}) {
  const existingRecord = activeBrowsers.get(browser);
  if (existingRecord) {
    return existingRecord;
  }

  const pid = browserPid(browser);
  const record = {
    browser,
    jobId,
    pid,
    startedAt,
    cleanupStarted: false,
    disconnected: false,
    closePromise: null
  };

  activeBrowsers.set(browser, record);
  browser.on?.('disconnected', () => {
    record.disconnected = true;
    activeBrowsers.delete(browser);
    log?.info?.({ jobId, chromium_pid: pid }, 'Browser disconnected');
  });

  return record;
}

export async function launchBrowser(
  proxy,
  { timeoutMs = config.browserTimeoutMs, jobId = undefined, log = undefined } = {}
) {
  const args = [];

  if (proxy) {
    args.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
  }

  if (process.env.PUPPETEER_NO_SANDBOX === 'true') {
    args.push('--no-sandbox');
  }

  if (process.env.PUPPETEER_DISABLE_DEV_SHM_USAGE === 'true') {
    args.push('--disable-dev-shm-usage');
  }

  const launchOptions = {
    headless: true,
    args,
    protocolTimeout: timeoutMs + 5000
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  log?.info?.({ jobId }, 'Browser launching');
  const browser = await puppeteer.launch(launchOptions);
  const record = trackBrowser(browser, { jobId, log });

  log?.info?.({ jobId, chromium_pid: record.pid }, 'Browser ready');
  return browser;
}

export async function safeCloseBrowser(
  browser,
  log = undefined,
  { timeoutMs = DEFAULT_BROWSER_CLOSE_TIMEOUT_MS } = {}
) {
  if (!browser) {
    return false;
  }

  const record = activeBrowsers.get(browser) ?? {
    browser,
    jobId: undefined,
    pid: browserPid(browser),
    startedAt: Date.now(),
    closePromise: null
  };

  if (record.closePromise) {
    return record.closePromise;
  }

  record.closePromise = (async () => {
    record.cleanupStarted = true;
    log?.info?.({ jobId: record.jobId, chromium_pid: record.pid }, 'Browser cleanup starting');

    try {
      await closeWithTimeout(browser, timeoutMs);
      activeBrowsers.delete(browser);
      log?.info?.({ jobId: record.jobId, chromium_pid: record.pid }, 'browser.close succeeded');
      return true;
    } catch (error) {
      log?.warn?.({ err: error, jobId: record.jobId, chromium_pid: record.pid }, 'browser.close failed or timed out');
      forceKillBrowserProcess(browser, log);
      activeBrowsers.delete(browser);
      return false;
    }
  })();

  if (activeBrowsers.has(browser)) {
    activeBrowsers.set(browser, record);
  }

  return record.closePromise;
}

export async function closeActiveBrowsers(log = undefined, { timeoutMs = DEFAULT_BROWSER_CLOSE_TIMEOUT_MS } = {}) {
  const browsers = Array.from(activeBrowsers.keys());

  await Promise.allSettled(
    browsers.map((browser) => safeCloseBrowser(browser, log, { timeoutMs }))
  );

  return browsers.length;
}
