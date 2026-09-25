import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright";

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  startShopFlow,
} from "./shopflow.js";

type TestDefinition = {
  id: string;
  name: string;
  run: (
    page: Page,
    artifactDir: string,
  ) => Promise<TestResult>;
};

type TestResult = {
  status: "PASSED" | "FAILED";
  states: string[];
  actions: number;
  durationMs: number;
  screenshots: string[];
  error?: string;
};

type RunResult = {
  id: string;
  name: string;
  status: "PASSED" | "FAILED";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  actions: number;
  states: string[];
  screenshots: string[];
  error?: string;
};

function hash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 10);
}

async function capture(
  page: Page,
  artifactDir: string,
  label: string,
): Promise<{
  title: string;
  url: string;
  screenshot: string;
}> {
  const title = await page.title();
  const url = await page.url();

  const screenshot = path.join(
    artifactDir,
    `${Date.now()}-${label}-${hash(url)}.png`,
  );

  await page.screenshot({
    path: screenshot,
    fullPage: true,
  });

  return {
    title,
    url,
    screenshot,
  };
}

async function runCheckout(
  page: Page,
  artifactDir: string,
): Promise<TestResult> {
  const started = Date.now();
  const states: string[] = [];
  const screenshots: string[] = [];
  let actions = 0;

  await page.goto(
    `${process.env.SHOPFLOW_URL}/`,
  );

  let snapshot = await capture(
    page,
    artifactDir,
    "home",
  );

  states.push(snapshot.title);
  screenshots.push(snapshot.screenshot);

  await page.getByRole("link", {
    name: "Browse Products",
    exact: true,
  }).click();

  actions++;

  snapshot = await capture(
    page,
    artifactDir,
    "products",
  );

  states.push(snapshot.title);
  screenshots.push(snapshot.screenshot);

  await page.getByRole("link", {
    name: "View Product",
    exact: true,
  }).first().click();

  actions++;

  snapshot = await capture(
    page,
    artifactDir,
    "product",
  );

  states.push(snapshot.title);
  screenshots.push(snapshot.screenshot);

  await page.getByRole("link", {
    name: "Add to Cart",
    exact: true,
  }).click();

  actions++;

  snapshot = await capture(
    page,
    artifactDir,
    "cart",
  );

  states.push(snapshot.title);
  screenshots.push(snapshot.screenshot);

  await page.getByRole("link", {
    name: "Checkout",
    exact: true,
  }).click();

  actions++;

  snapshot = await capture(
    page,
    artifactDir,
    "checkout",
  );

  states.push(snapshot.title);
  screenshots.push(snapshot.screenshot);

  const passed =
    snapshot.title === "Checkout";

  return {
    status: passed
      ? "PASSED"
      : "FAILED",
    states,
    actions,
    durationMs:
      Date.now() - started,
    screenshots,
  };
}

async function runWishlist(
  page: Page,
  artifactDir: string,
): Promise<TestResult> {
  const started = Date.now();
  const states: string[] = [];
  const screenshots: string[] = [];
  let actions = 0;

  await page.goto(
    `${process.env.SHOPFLOW_URL}/product/1`,
  );

  let snapshot = await capture(
    page,
    artifactDir,
    "product",
  );

  states.push(snapshot.title);
  screenshots.push(snapshot.screenshot);

  await page.getByRole("link", {
    name: "Wishlist",
    exact: true,
  }).click();

  actions++;

  snapshot = await capture(
    page,
    artifactDir,
    "wishlist",
  );

  states.push(snapshot.title);
  screenshots.push(snapshot.screenshot);

  const passed =
    snapshot.title === "Wishlist";

  return {
    status: passed
      ? "PASSED"
      : "FAILED",
    states,
    actions,
    durationMs:
      Date.now() - started,
    screenshots,
  };
}

async function runProductDiscovery(
  page: Page,
  artifactDir: string,
): Promise<TestResult> {
  const started = Date.now();
  const states: string[] = [];
  const screenshots: string[] = [];
  let actions = 0;

  await page.goto(
    `${process.env.SHOPFLOW_URL}/products`,
  );

  let snapshot = await capture(
    page,
    artifactDir,
    "products",
  );

  states.push(snapshot.title);
  screenshots.push(snapshot.screenshot);

  await page.getByRole("link", {
    name: "View Product",
    exact: true,
  }).nth(1).click();

  actions++;

  snapshot = await capture(
    page,
    artifactDir,
    "keyboard",
  );

  states.push(snapshot.title);
  screenshots.push(snapshot.screenshot);

  const passed =
    snapshot.title ===
    "Mechanical Keyboard";

  return {
    status: passed
      ? "PASSED"
      : "FAILED",
    states,
    actions,
    durationMs:
      Date.now() - started,
    screenshots,
  };
}

async function executeRun(
  browserContext: BrowserContext,
  test: TestDefinition,
  rootArtifactDir: string,
): Promise<RunResult> {
  const runArtifactDir =
    path.join(
      rootArtifactDir,
      test.id,
    );

  await fs.mkdir(
    runArtifactDir,
    {
      recursive: true,
    },
  );

  const startedAt =
    new Date().toISOString();

  const started =
    Date.now();

  console.log(
    `[parallel:${test.id}] START ${test.name}`,
  );

  const page =
    await browserContext.newPage();

  try {
    const result =
      await test.run(
        page,
        runArtifactDir,
      );

    const finishedAt =
      new Date().toISOString();

    console.log(
      `[parallel:${test.id}] ${result.status} ${test.name} ${result.durationMs}ms`,
    );

    return {
      id: test.id,
      name: test.name,
      status: result.status,
      startedAt,
      finishedAt,
      durationMs:
        result.durationMs ||
        Date.now() - started,
      actions: result.actions,
      states: result.states,
      screenshots:
        result.screenshots,
      ...(result.error
        ? { error: result.error }
        : {}),
    };
  } catch (error: unknown) {
    const finishedAt =
      new Date().toISOString();

    const durationMs =
      Date.now() - started;

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `[parallel:${test.id}] FAILED ${message}`,
    );

    return {
      id: test.id,
      name: test.name,
      status: "FAILED",
      startedAt,
      finishedAt,
      durationMs,
      actions: 0,
      states: [],
      screenshots: [],
      error: message,
    };
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const shopflow =
    await startShopFlow();

  process.env.SHOPFLOW_URL =
    shopflow.url;

  const artifactDir =
    path.resolve(
      "artifacts/meu-demo/parallel",
    );

  await fs.mkdir(
    artifactDir,
    {
      recursive: true,
    },
  );

  const tests:
    TestDefinition[] = [
      {
        id: "checkout",
        name: "Checkout Flow",
        run: runCheckout,
      },
      {
        id: "wishlist",
        name: "Wishlist Flow",
        run: runWishlist,
      },
      {
        id: "product-discovery",
        name: "Product Discovery",
        run: runProductDiscovery,
      },
    ];

  const browser =
    await chromium.launch({
      headless: false,
    });

  try {
    console.log(
      `[parallel] ShopFlow=${shopflow.url}`,
    );

    console.log(
      `[parallel] launching ${tests.length} isolated test contexts`,
    );

    const started =
      Date.now();

    /*
     * Each test receives its own BrowserContext.
     *
     * This provides isolated cookies,
     * storage, pages, and browser state.
     */
    const executions =
      tests.map(async (test) => {
        const context =
          await browser.newContext();

        try {
          return await executeRun(
            context,
            test,
            artifactDir,
          );
        } finally {
          await context.close();
        }
      });

    const results =
      await Promise.all(
        executions,
      );

    const wallClockMs =
      Date.now() - started;

    const passed =
      results.filter(
        (result) =>
          result.status ===
          "PASSED",
      ).length;

    const failed =
      results.length - passed;

    const summary = {
      experiment:
        "Parallel MEU runs",

      application:
        "ShopFlow",

      total:
        results.length,

      passed,

      failed,

      wallClockMs,

      results,

      createdAt:
        new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(
        artifactDir,
        "parallel-summary.json",
      ),
      JSON.stringify(
        summary,
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      "\n[parallel] ===============================",
    );

    for (const result of results) {
      console.log(
        `[parallel] ${result.status} | ${result.name} | ${result.durationMs}ms | actions=${result.actions}`,
      );
    }

    console.log(
      `[parallel] total=${results.length} passed=${passed} failed=${failed}`,
    );

    console.log(
      `[parallel] wall-clock=${wallClockMs}ms`,
    );

    console.log(
      `[parallel] evidence=${artifactDir}`,
    );

    console.log(
      "[parallel] ===============================",
    );

    if (failed > 0) {
      throw new Error(
        `${failed} parallel test(s) failed`,
      );
    }

    console.log(
      "[parallel] PASS — independent MEU test runs executed concurrently",
    );
  } finally {
    await browser.close();
    await shopflow.close();
  }
}

main().catch(
  (error: unknown) => {
    console.error(
      "[parallel] failed:",
      error,
    );

    process.exit(1);
  },
);