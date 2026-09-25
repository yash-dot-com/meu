import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: false,
});

console.log("[browser] launched");

const page = await browser.newPage({
  viewport: {
    width: 1000,
    height: 700,
  },
});

await page.setContent(`
  <!DOCTYPE html>
  <html>
    <body>
      <h1>ShopFlow</h1>

      <main>
        <section id="checkout-area">
          <h2>Your cart</h2>
          <button id="checkout">Checkout</button>
        </section>
      </main>
    </body>
  </html>
`);

console.log("[page] loaded");
console.log("[state] version 1");

// This is the important part.
// We identify the button by meaning, not CSS selector.
const checkout = page.getByRole("button", {
  name: "Checkout",
});

console.log(
  "[locator] count:",
  await checkout.count(),
);

console.log(
  "[locator] visible:",
  await checkout.isVisible(),
);

console.log(
  "[locator] box:",
  await checkout.boundingBox(),
);

await checkout.click();

console.log("[action] clicked Checkout");

// --------------------------------------------------
// MUTATE THE UI
// --------------------------------------------------

await page.evaluate(() => {
  document.body.innerHTML = `
    <main>
      <div class="new-layout">
        <section>
          <div>
            <article>
              <div class="actions">
                <button id="new-checkout">
                  Checkout
                </button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </main>
  `;
});

console.log("[mutation] DOM structure changed");

console.log(
  "[locator] count after mutation:",
  await checkout.count(),
);

console.log(
  "[locator] visible after mutation:",
  await checkout.isVisible(),
);

console.log(
  "[locator] new box:",
  await checkout.boundingBox(),
);

// Re-use the SAME locator.
await checkout.click();

console.log("[action] clicked Checkout after DOM mutation");

await page.screenshot({
  path: "artifacts/05-semantic-after-mutation.png",
});

console.log("[screenshot] saved");

await browser.close();

console.log("[browser] closed");