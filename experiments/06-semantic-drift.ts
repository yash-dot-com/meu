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

      <section>
        <h2>Your cart</h2>
        <button id="checkout">Checkout</button>
      </section>
    </body>
  </html>
`);

console.log("[page] loaded");
console.log("[state] version 1");

const checkout = page.getByRole("button", {
  name: "Checkout",
});

console.log(
  "[locator] original count:",
  await checkout.count(),
);

await checkout.click();

console.log("[action] original Checkout clicked");

// --------------------------------------------------
// UI CHANGE
// Same intent, different wording.
// --------------------------------------------------

await page.evaluate(() => {
  const button = document.querySelector("#checkout");

  if (!button) {
    throw new Error("Original checkout button not found");
  }

  button.textContent = "Proceed to Payment";
});

console.log("[mutation] button renamed");
console.log("[mutation] Checkout -> Proceed to Payment");

console.log(
  "[locator] old locator count:",
  await checkout.count(),
);

// --------------------------------------------------
// Try to find the new representation.
// --------------------------------------------------

const newTarget = page.getByRole("button", {
  name: "Proceed to Payment",
});

console.log(
  "[locator] new target count:",
  await newTarget.count(),
);

console.log(
  "[locator] new target visible:",
  await newTarget.isVisible(),
);

console.log(
  "[locator] new target box:",
  await newTarget.boundingBox(),
);

await newTarget.click();

console.log("[action] new target clicked");

await page.screenshot({
  path: "artifacts/06-semantic-drift.png",
});

console.log("[screenshot] saved");

await browser.close();

console.log("[browser] closed");