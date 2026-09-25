import { createServer } from "node:http";
import { chromium, type Page } from "playwright";

type State = {
  id: string;
  url: string;
  heading: string;
  actions: string[];
  screenshot: string;
};

type Transition = {
  from: State;
  action: string;
  to: State;
  durationMs: number;
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function captureState(
  page: Page,
  label: string,
): Promise<State> {
  const heading = (
    await page.locator("h1").innerText()
  ).trim();

  const actions = await page
    .getByRole("button")
    .allTextContents();

  const cleanActions = actions
    .map(normalize)
    .filter(Boolean);

  const url = page.url();

  const id = [
    new URL(url).pathname,
    normalize(heading),
    ...cleanActions.sort(),
  ].join("|");

  const screenshot =
    `artifacts/14-${label}.png`;

  await page.screenshot({
    path: screenshot,
    fullPage: true,
  });

  console.log(
    `[observe] ${label}`,
  );

  console.log(
    `  url="${new URL(url).pathname}"`,
  );

  console.log(
    `  heading="${heading}"`,
  );

  console.log(
    `  actions=${cleanActions.length}`,
  );

  console.log(
    `  id=${id}`,
  );

  return {
    id,
    url,
    heading,
    actions: cleanActions,
    screenshot,
  };
}

async function executeTransition(
  page: Page,
  label: string,
  action: string,
): Promise<Transition> {
  console.log(`\n[scenario] ${label}`);

  const before = await captureState(
    page,
    `${label}-before`,
  );

  const target = page.getByRole("button", {
    name: action,
  });

  const count = await target.count();

  console.log(
    `[action] target="${action}" count=${count}`,
  );

  if (count !== 1) {
    throw new Error(
      `Expected exactly one "${action}" button, found ${count}`,
    );
  }

  const start = performance.now();

  await target.click();

  const durationMs = Math.round(
    performance.now() - start,
  );

  console.log(
    `[action] "${action}" completed in ${durationMs}ms`,
  );

  // Give the application a chance to render its
  // new state. This is intentionally small.
  await page.waitForLoadState("networkidle").catch(
    () => {},
  );

  const after = await captureState(
    page,
    `${label}-after`,
  );

  console.log(
    `[transition] ${before.heading} --"${action}"--> ${after.heading}`,
  );

  return {
    from: before,
    action,
    to: after,
    durationMs,
  };
}

// --------------------------------------------------
// LOCAL SHOPFLOW SERVER
// --------------------------------------------------

const html = `
<!DOCTYPE html>

<html>
  <head>
    <meta charset="UTF-8" />
    <title>ShopFlow</title>

    <style>
      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family:
          system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;

        background: #f7f7f7;
        color: #111;
      }

      main {
        max-width: 720px;
        margin: 0 auto;
        padding: 80px 32px;
      }

      article {
        padding: 28px;
        border: 1px solid #ddd;
        border-radius: 16px;
        background: white;
      }

      button {
        margin: 8px 8px 0 0;
        padding: 12px 18px;
        border: 1px solid #ccc;
        border-radius: 10px;
        background: white;
        color: #111;
        font-size: 15px;
        cursor: pointer;
      }

      button:hover {
        background: #f1f1f1;
      }
    </style>
  </head>

  <body>
    <main id="app"></main>

    <script>
      const app =
        document.getElementById("app");

      function renderCheckout() {
        app.innerHTML = \`
          <article>
            <h1>Checkout</h1>

            <h2>MacBook Pro</h2>

            <p>₹1,89,000</p>

            <button data-action="checkout">
              Checkout
            </button>

            <button data-action="cancel">
              Cancel Order
            </button>
          </article>
        \`;
      }

      function renderReviewOrder() {
        app.innerHTML = \`
          <article>
            <h1>Review Order</h1>

            <h2>MacBook Pro</h2>

            <p>₹1,89,000</p>

            <button data-action="payment">
              Proceed to Payment
            </button>
          </article>
        \`;
      }

      function renderPayment() {
        app.innerHTML = \`
          <article>
            <h1>Payment</h1>

            <h2>Order Summary</h2>

            <p>MacBook Pro — ₹1,89,000</p>

            <button data-action="pay">
              Pay Now
            </button>
          </article>
        \`;
      }

      function renderHome() {
        app.innerHTML = \`
          <article>
            <h1>ShopFlow</h1>

            <p>Welcome to ShopFlow.</p>

            <button data-action="browse">
              Browse Products
            </button>
          </article>
        \`;
      }

      function render() {
        switch (window.location.pathname) {
          case "/checkout":
            renderCheckout();
            break;

          case "/review-order":
            renderReviewOrder();
            break;

          case "/payment":
            renderPayment();
            break;

          default:
            renderHome();
        }
      }

      document.addEventListener(
        "click",
        (event) => {
          const button =
            event.target.closest("button");

          if (!button) {
            return;
          }

          const action =
            button.dataset.action;

          switch (action) {
            case "checkout":
            case "payment":
              history.pushState(
                {},
                "",
                "/payment",
              );
              render();
              break;

            case "cancel":
              history.pushState(
                {},
                "",
                "/",
              );
              render();
              break;

            case "browse":
              history.pushState(
                {},
                "",
                "/checkout",
              );
              render();
              break;

            case "pay":
              break;
          }
        },
      );

      window.addEventListener(
        "popstate",
        render,
      );

      render();
    </script>
  </body>
</html>
`;

const server = createServer(
  (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html",
    });

    response.end(html);
  },
);

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    resolve();
  });
});

const address = server.address();

if (!address || typeof address === "string") {
  throw new Error(
    "Could not determine server address",
  );
}

const baseUrl = `http://127.0.0.1:${address.port}`;

console.log(
  `[server] ShopFlow running at ${baseUrl}`,
);

// --------------------------------------------------
// BROWSER
// --------------------------------------------------

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

// ==================================================
// A
// CHECKOUT → PAYMENT
// ==================================================

console.log(
  "\n[navigate] /checkout",
);

await page.goto(
  `${baseUrl}/checkout`,
  {
    waitUntil: "domcontentloaded",
  },
);

console.log(
  "[page] Checkout loaded",
);

const transitionA =
  await executeTransition(
    page,
    "A-checkout",
    "Checkout",
  );

// ==================================================
// B
// REVIEW ORDER → PAYMENT
// ==================================================

console.log(
  "\n[navigate] /review-order",
);

await page.goto(
  `${baseUrl}/review-order`,
  {
    waitUntil: "domcontentloaded",
  },
);

console.log(
  "[page] Review Order loaded",
);

const transitionB =
  await executeTransition(
    page,
    "B-review-order",
    "Proceed to Payment",
  );

// ==================================================
// C
// CHECKOUT → HOME
// ==================================================

console.log(
  "\n[navigate] /checkout",
);

await page.goto(
  `${baseUrl}/checkout`,
  {
    waitUntil: "domcontentloaded",
  },
);

console.log(
  "[page] Checkout loaded",
);

const transitionC =
  await executeTransition(
    page,
    "C-cancel",
    "Cancel Order",
  );

// ==================================================
// RESULTS
// ==================================================

console.log(
  "\n==============================",
);

console.log(
  "[learned transitions]",
);

console.log(
  "==============================",
);

function printTransition(
  transition: Transition,
): void {
  console.log(
    `${transition.from.heading} --"${transition.action}"--> ${transition.to.heading}`,
  );

  console.log(
    `  from=${transition.from.id}`,
  );

  console.log(
    `  to=${transition.to.id}`,
  );

  console.log(
    `  duration=${transition.durationMs}ms`,
  );
}

printTransition(transitionA);

printTransition(transitionB);

printTransition(transitionC);

console.log(
  "\n==============================",
);

console.log(
  "[behavior comparison]",
);

console.log(
  "==============================",
);

console.log(
  "[A vs B] same destination:",
  transitionA.to.id === transitionB.to.id,
);

console.log(
  "[A vs C] same destination:",
  transitionA.to.id === transitionC.to.id,
);

console.log("\n[expected]");

console.log(
  "A and B should reach the same Payment state.",
);

console.log(
  "C should reach the Home state.",
);

await browser.close();

console.log("\n[browser] closed");

await new Promise<void>((resolve) => {
  server.close(() => resolve());
});

console.log("[server] closed");