import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const sodium = createRequire(import.meta.url)("libsodium-wrappers");

function required(name) {
  if (!process.env[name]) throw new Error(`${name} is required for session refresh.`);
  return process.env[name];
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if (await input.count()) return input.fill(value);
  }
  throw new Error(`LeetCode login form did not contain ${selectors.join(" or ")}.`);
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.count()) return button.click();
  }
  throw new Error("LeetCode login submit button was not found.");
}

async function login() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("https://leetcode.com/accounts/login/", { waitUntil: "domcontentloaded" });
    await fillFirst(page, ['input[name="login"]', 'input[name="username"]', 'input[type="email"]'], required("LEETCODE_USERNAME"));
    await fillFirst(page, ['input[name="password"]', 'input[type="password"]'], required("LEETCODE_PASSWORD"));
    await clickFirst(page, ['button[type="submit"]', 'input[type="submit"]']);
    await page.waitForTimeout(4_000);
    const pageText = await page.locator("body").innerText();
    if (/captcha|verify you are human|recaptcha|turnstile/i.test(pageText)) {
      throw new Error("LeetCode showed a CAPTCHA; headless login cannot continue.");
    }
    const cookies = await page.context().cookies("https://leetcode.com");
    const byName = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
    const session = byName.get("LEETCODE_SESSION");
    const csrf = byName.get("csrftoken");
    if (!session || !csrf) throw new Error("LeetCode login did not produce LEETCODE_SESSION and csrftoken cookies.");
    return { session, csrf };
  } finally {
    await browser.close();
  }
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${required("GH_SECRETS_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub secret update failed (${response.status}): ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function updateSecret(repository, name, value) {
  const key = await github(`/repos/${repository}/actions/secrets/public-key`);
  await sodium.ready;
  const encrypted = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)),
    sodium.base64_variants.ORIGINAL,
  );
  await github(`/repos/${repository}/actions/secrets/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ encrypted_value: encrypted, key_id: key.key_id }),
  });
}

export async function main() {
  const repository = required("GITHUB_REPOSITORY");
  const { session, csrf } = await login();
  await Promise.all([
    updateSecret(repository, "LEETCODE_SESSION", session),
    updateSecret(repository, "LEETCODE_CSRF_TOKEN", csrf),
  ]);
  if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required so the retry can use the fresh cookies.");
  appendFileSync(process.env.GITHUB_ENV, `LEETCODE_SESSION=${session}\nLEETCODE_CSRF_TOKEN=${csrf}\n`);
  console.log("[leetcode-sync] Refreshed LeetCode session and repository secrets.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[leetcode-sync] ${error.message}`);
    process.exitCode = 1;
  });
}
