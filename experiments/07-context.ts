import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: false,
});

console.log("[browser] launched");

const page = await browser.newPage({
  viewport: {
    width: 1100,
    height: 700,
  },
});

await page.setContent(`
  <!DOCTYPE html>
  <html>
    <head>
      <style>
        body {
          font-family: system-ui, sans-serif;
          padding: 40px;
        }

        .products {
          display: flex;
          gap: 24px;
        }

        article {
          width: 280px;
          padding: 24px;
          border: 1px solid #ccc;
          border-radius: 12px;
        }

        button {
          margin-top: 20px;
          padding: 10px 18px;
          cursor: pointer;
        }
      </style>
    </head>

    <body>
      <h1>ShopFlow</h1>

      <div class="products">

        <article>
          <h2>MacBook Pro</h2>
          <p>₹1,89,000</p>
          <button>Checkout</button>
        </article>

        <article>
          <h2>ThinkPad X1 Carbon</h2>
          <p>₹1,42,000</p>
          <button>Checkout</button>
        </article>

      </div>
    </body>
  </html>
`);

console.log("[page] loaded");
console.log("[state] two identical Checkout targets");

// --------------------------------------------------
// 1. Global semantic lookup
// --------------------------------------------------

const checkoutButtons = page.getByRole("button", {
  name: "Checkout",
});

console.log(
  "[global locator] count:",
  await checkoutButtons.count(),
);

// --------------------------------------------------
// 2. Inspect the surrounding semantic structure
// --------------------------------------------------

const articles = page.locator("article");

console.log(
  "[context] article count:",
  await articles.count(),
);

for (let i = 0; i < await articles.count(); i++) {
  const article = articles.nth(i);

  console.log(`\n[context] article ${i + 1}`);

  console.log(
    "  text:",
    (await article.innerText()).replace(/\s+/g, " ").trim(),
  );

  console.log(
    "  checkout buttons:",
    await article.getByRole("button", {
      name: "Checkout",
    }).count(),
  );
}

// --------------------------------------------------
// 3. Resolve using application context
// --------------------------------------------------

const macBookCard = page
  .locator("article")
  .filter({
    hasText: "MacBook Pro",
  });

const macBookCheckout = macBookCard.getByRole("button", {
  name: "Checkout",
});

console.log("\n[resolver] MacBook Checkout count:", await macBookCheckout.count());

console.log(
  "[resolver] MacBook Checkout box:",
  await macBookCheckout.boundingBox(),
);

await macBookCheckout.click();

console.log("[action] clicked MacBook Checkout");

// --------------------------------------------------
// 4. Take screenshot
// --------------------------------------------------

await page.screenshot({
  path: "artifacts/07-context.png",
  fullPage: true,
});

console.log("[screenshot] saved");

await browser.close();

console.log("[browser] closed");