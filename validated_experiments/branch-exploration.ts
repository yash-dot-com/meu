import {
  localBrowser,
  Stagehand,
} from "@browserbasehq/stagehand";

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { startShopFlow } from "./shopflow.js";

type Memory = {
  targets?: Array<{
    intent: string;
    role: string;
    names: string[];
    href: string;
    path: string;
  }>;
  states?: Array<{
    id: string;
    url: string;
    title: string;
    screenshot: string;
  }>;
  transitions?: Array<{
    id: string;
    fromState: string;
    toState: string;
    intent: string;
    executor: "playwright" | "stagehand";
    recovered: boolean;
    verified: boolean;
  }>;
  events?: unknown[];
};

type CandidateAction = {
  selector: string;
  description?: string;
  method?: string;
  arguments?: unknown[];
};

type BranchEvidence = {
  experiment: "S3";
  state: {
    id: string;
    title: string;
    url: string;
  };
  candidates: CandidateAction[];
  knownActions: string[];
  selectedBranch: {
    name: string;
    selector: string;
    description: string;
  };
  result: {
    title: string;
    url: string;
    verified: boolean;
    durationMs: number;
  };
  screenshot: string;
  recordedAt: string;
};

function shortHash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

async function loadMemory(
  memoryPath: string,
): Promise<Memory> {
  try {
    return JSON.parse(
      await fs.readFile(memoryPath, "utf8"),
    ) as Memory;
  } catch {
    return {};
  }
}

async function captureStateId(
  page: {
    url(): Promise<string>;
    title(): Promise<string>;
  },
): Promise<{
  id: string;
  title: string;
  url: string;
}> {
  const url = await page.url();
  const title = await page.title();

  const id = `state_${shortHash(
    `${new URL(url).pathname}:${title}`,
  )}`;

  return {
    id,
    title,
    url,
  };
}

function getKnownActionsForState(
  memory: Memory,
  stateId: string,
): string[] {
  const transitions = memory.transitions ?? [];

  return transitions
    .filter(
      (transition) =>
        transition.fromState === stateId,
    )
    .map(
      (transition) => transition.intent,
    );
}

async function main(): Promise<void> {
  const apiKey =
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set.",
    );
  }

  const shopflow =
    await startShopFlow();

  const artifactDir =
    path.resolve(
      "artifacts/meu-demo/branch",
    );

  await fs.mkdir(
    artifactDir,
    { recursive: true },
  );

  const memoryPath =
    path.resolve(
      "artifacts/meu-demo/integrated-memory.json",
    );

  const memory =
    await loadMemory(memoryPath);

  let browser:
    | Awaited<
        ReturnType<
          typeof localBrowser.launch
        >
      >
    | undefined;

  let stagehand:
    | Awaited<
        ReturnType<
          typeof Stagehand.create
        >
      >
    | undefined;

  try {
    console.log(
      "[s3] launching Stagehand v4",
    );

    browser =
      await localBrowser.launch({
        headless: false,
      });

    stagehand =
      await Stagehand.create({
        browser,
        model: {
          modelName:
            "openai/gpt-5.4-mini",
          apiKey,
        },
      });

    const pages =
      await browser.context.pages();

    if (pages.length === 0) {
      throw new Error(
        "Stagehand created no pages.",
      );
    }

    const page = pages[0];

    // Start at the product page where our
    // previous MEU run knows "Add to Cart".
    const productUrl =
      `${shopflow.url}/product/1`;

    console.log(
      `[s3] opening ${productUrl}`,
    );

    await page.goto(productUrl);

    const currentState =
      await captureStateId(page);

    console.log(
      `[s3] state=${currentState.title}`,
    );

    const knownActions =
      getKnownActionsForState(
        memory,
        currentState.id,
      );

    console.log(
      `[s3] known actions=${
        knownActions.length > 0
          ? knownActions.join(", ")
          : "none"
      }`,
    );

    // --------------------------------------------------
    // 1. Ask Stagehand for meaningful actions
    // --------------------------------------------------

    console.log(
      "[s3] asking Stagehand for meaningful product actions",
    );

    const observation =
      await stagehand.observe(
        "Find meaningful user actions in the main product content that can lead to a different application state. Ignore global navigation such as Home and Products. Return actionable controls such as Add to Cart, Wishlist, Buy Now, or similar product actions.",
      );

    const candidates =
      (observation.data ??
        []) as CandidateAction[];

    console.log(
      `[s3] candidate actions=${candidates.length}`,
    );

    for (const candidate of candidates) {
      console.log(
        `[s3] candidate=${candidate.description ?? candidate.selector}`,
      );
    }

    if (candidates.length === 0) {
      throw new Error(
        "Stagehand found no exploration candidates.",
      );
    }

    // --------------------------------------------------
    // 2. Remove already-known actions
    // --------------------------------------------------

    const unexplored =
      candidates.filter(
        (candidate) => {
          const description =
            (
              candidate.description ??
              ""
            ).toLowerCase();

          return !knownActions.some(
            (knownAction) =>
              description.includes(
                knownAction.toLowerCase(),
              ),
          );
        },
      );

    console.log(
      `[s3] unexplored candidates=${unexplored.length}`,
    );

    if (unexplored.length === 0) {
      throw new Error(
        "No unexplored meaningful branch found.",
      );
    }

    // For tonight's prototype, explore exactly
    // one new branch.
    const branch =
      unexplored.find((candidate) =>
        (
          candidate.description ?? ""
        )
          .toLowerCase()
          .includes("wishlist"),
      ) ??
      unexplored[0];

    const branchName =
      branch.description ??
      "unexplored action";

    console.log(
      `[s3] selected branch="${branchName}"`,
    );

    // --------------------------------------------------
    // 3. Screenshot before exploration
    // --------------------------------------------------

    const beforeScreenshot =
      path.join(
        artifactDir,
        "before-branch.png",
      );

    await page.screenshot({
      path: beforeScreenshot,
      fullPage: true,
    });

    // --------------------------------------------------
    // 4. Execute the AI-discovered action
    // --------------------------------------------------
    //
    // Stagehand observe() returned the real selector.
    // We now execute deterministically through the
    // Stagehand v4 locator API.
    // --------------------------------------------------

    const started =
      Date.now();

    const target =
      page.locator(
        branch.selector,
      );

    await target.click();

    const durationMs =
      Date.now() - started;

    const finalTitle =
      await page.title();

    const finalUrl =
      await page.url();

    // --------------------------------------------------
    // 5. Verify
    // --------------------------------------------------

    const expectedBranch =
      branchName
        .toLowerCase()
        .includes("wishlist");

    const verified =
      expectedBranch
        ? finalTitle ===
          "Wishlist"
        : finalTitle !==
          currentState.title;

    console.log(
      `[s3] result=${finalTitle}`,
    );

    console.log(
      `[s3] url=${finalUrl}`,
    );

    console.log(
      `[s3] verified=${verified}`,
    );

    const afterScreenshot =
      path.join(
        artifactDir,
        "after-branch.png",
      );

    await page.screenshot({
      path: afterScreenshot,
      fullPage: true,
    });

    const nextState =
      await captureStateId(page);

    // --------------------------------------------------
    // 6. Record branch evidence
    // --------------------------------------------------

    const evidence: BranchEvidence = {
      experiment: "S3",

      state: currentState,

      candidates,

      knownActions,

      selectedBranch: {
        name: branchName,
        selector: branch.selector,
        description:
          branch.description ??
          "AI-discovered branch",
      },

      result: {
        title: finalTitle,
        url: finalUrl,
        verified,
        durationMs,
      },

      screenshot: afterScreenshot,

      recordedAt:
        new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(
        artifactDir,
        "s3-branch.json",
      ),
      JSON.stringify(
        evidence,
        null,
        2,
      ),
      "utf8",
    );

    // --------------------------------------------------
    // 7. Persist the discovered branch
    // --------------------------------------------------

    const memoryStates =
      memory.states ?? [];

    const memoryTransitions =
      memory.transitions ?? [];

    if (
      !memoryStates.some(
        (state) =>
          state.id === nextState.id,
      )
    ) {
      memoryStates.push({
        id: nextState.id,
        title: nextState.title,
        url: nextState.url,
        screenshot:
          afterScreenshot,
      });
    }

    memoryTransitions.push({
      id: `transition_${shortHash(
        `${currentState.id}:${branchName}:${nextState.id}`,
      )}`,

      fromState:
        currentState.id,

      toState:
        nextState.id,

      intent:
        branchName,

      executor:
        "stagehand",

      recovered:
        false,

      verified,
    });

    memory.states =
      memoryStates;

    memory.transitions =
      memoryTransitions;

    await fs.writeFile(
      memoryPath,
      JSON.stringify(
        memory,
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      `[s3] graph branch added: ${currentState.title} → ${branchName} → ${nextState.title}`,
    );

    console.log(
      `[s3] memory saved=${memoryPath}`,
    );

    if (!verified) {
      throw new Error(
        "Branch verification failed.",
      );
    }

    console.log(
      "[s3] PASS — AI discovered and verified a new branch",
    );
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (error) {
        console.error(
          "[s3] Stagehand close failed:",
          error,
        );
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error(
          "[s3] browser close failed:",
          error,
        );
      }
    }

    await shopflow.close();
  }
}

main().catch(
  (error: unknown) => {
    console.error(
      "[s3] failed:",
      error,
    );

    process.exit(1);
  },
);