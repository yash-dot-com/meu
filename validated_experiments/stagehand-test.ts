import {
  localBrowser,
  Stagehand,
} from "@browserbasehq/stagehand";

import { startShopFlow } from "./shopflow.js";

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set in the environment",
    );
  }

  const shopflow = await startShopFlow();

  let browser:
    | Awaited<
        ReturnType<typeof localBrowser.launch>
      >
    | undefined;

  let stagehand:
    | Awaited<
        ReturnType<typeof Stagehand.create>
      >
    | undefined;

  try {
    console.log(
      "[stagehand] launching local browser",
    );

    browser = await localBrowser.launch({
      headless: false,
    });

    console.log(
      "[stagehand] creating Stagehand",
    );

    stagehand = await Stagehand.create({
      browser,
      model: {
        modelName: "openai/gpt-5.4-mini",
        apiKey,
      },
    });

    const pages =
      await browser.context.pages();

    if (pages.length === 0) {
      throw new Error(
        "No browser pages available",
      );
    }

    const page = pages[0];

    console.log(
      `[stagehand] opening ${shopflow.url}`,
    );

    await page.goto(shopflow.url);

    console.log(
      '[stagehand] action: "click Browse Products"',
    );

    const result = await stagehand.act(
      "click the Browse Products link",
    );

    console.log(
      "[stagehand] raw act result:",
    );

    console.log(
      JSON.stringify(
        result,
        null,
        2,
      ),
    );

    const currentUrl =
      await page.url();

    const currentTitle =
      await page.title();

    console.log(
      `[stagehand] currentUrl=${currentUrl}`,
    );

    console.log(
      `[stagehand] currentTitle=${currentTitle}`,
    );

    const passed =
      currentTitle === "Products";

    console.log(
      `[stagehand] ${passed ? "PASS" : "FAIL"}`,
    );

    if (!passed) {
      throw new Error(
        "Stagehand action did not reach Products",
      );
    }
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();

        console.log(
          "[stagehand] Stagehand closed",
        );
      } catch (error) {
        console.error(
          "[stagehand] close failed:",
          error,
        );
      }
    }

    if (browser) {
      try {
        await browser.close();

        console.log(
          "[stagehand] browser closed",
        );
      } catch (error) {
        console.error(
          "[stagehand] browser close failed:",
          error,
        );
      }
    }

    await shopflow.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    "[stagehand] fatal:",
    error,
  );

  process.exit(1);
});