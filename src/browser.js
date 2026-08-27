import puppeteer from 'puppeteer';
import { config } from './config.js';

export async function launchBrowser(proxy, { timeoutMs = config.browserTimeoutMs } = {}) {
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

  return puppeteer.launch(launchOptions);
}

export async function safeCloseBrowser(browser, log = undefined) {
  if (!browser) {
    return false;
  }

  try {
    await browser.close();
    return true;
  } catch (error) {
    log?.warn?.({ err: error }, 'Failed to close browser cleanly');
    return false;
  }
}
