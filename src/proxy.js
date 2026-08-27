import { config } from './config.js';

const IPIFY_URL = 'https://api.ipify.org?format=json';

export async function authenticateProxy(page, proxy) {
  await page.authenticate({
    username: proxy.username,
    password: proxy.password
  });
}

export async function checkExitIp(page, { timeoutMs = config.ipCheckTimeoutMs } = {}) {
  try {
    const response = await page.goto(IPIFY_URL, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });
    const ipData = await response.json();
    return ipData && ipData.ip ? String(ipData.ip) : 'unknown';
  } catch {
    return 'unknown';
  }
}
