import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

await mkdir("artifacts", {
  recursive: true,
});

const browser = await chromium.launch({
  headless: false,
});

console.log("[browser] launched");

const context = await browser.newContext({
  viewport: {
    width: 1000,
    height: 700,
  },
});

console.log("[context] created");

await context.tracing.start({
  screenshots: true,
  snapshots: true,
  sources: true,
});

console.log("[trace] recording started");

const page = await context.newPage();

await page.setContent(`
  <!DOCTYPE html>

  <html>
    <head>
      <title>ShopFlow</title>

      <style>
        body {
          font-family: system-ui, sans-serif;
          padding: 48px;
        }

        button {
          margin: 8px;
          padding: 12px 18px;
          font-size: 16px;
          cursor: pointer;
        }

        #status {
          margin-top: 24px;
          padding: 16px;
          border-radius: 10px;
          background: #f1f1f1;
        }
      </style>
    </head>

    <body>
      <main>
        <h1>ShopFlow</h1>

        <h2>MacBook Pro</h2>

        <p>₹1,89,000</p>

        <button>
          Add to Cart
        </button>

        <button>
          Buy Now
        </button>

        <div id="status">
          Cart is empty
        </div>
      </main>
    </body>
  </html>
`);

console.log("[page] loaded");

const addToCart = page.getByRole("button", {
  name: "Add to Cart",
});

const buyNow = page.getByRole("button", {
  name: "Buy Now",
});

console.log(
  "[target] Add to Cart count:",
  await addToCart.count(),
);

console.log(
  "[target] Buy Now count:",
  await buyNow.count(),
);

await addToCart.click();

console.log("[action] Add to Cart clicked");

await page.locator("#status").waitFor();

await buyNow.click();

console.log("[action] Buy Now clicked");

await page.waitForTimeout(300);

console.log(
  "[trace] actions completed",
);

await context.tracing.stop({
  path: "artifacts/15-trace.zip",
});

console.log(
  "[trace] saved: artifacts/15-trace.zip",
);

await context.close();

await browser.close();

console.log("[browser] closed");