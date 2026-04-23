const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true
  });

  const page = await browser.newPage();

  await page.setContent("<h1>Hello AI Sandbox</h1>");

  const text = await page.textContent("h1");
  console.log(text);

  await browser.close();
})();
