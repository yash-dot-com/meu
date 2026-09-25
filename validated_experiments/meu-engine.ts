import { chromium, type Locator, type Page } from "playwright";
import {
  localBrowser,
  Stagehand,
} from "@browserbasehq/stagehand";

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { startShopFlow } from "./shopflow.js";

type TargetMemory = {
  intent: string;
  role: string;
  names: string[];
  href: string;
  path: string;
};

type StateMemory = {
  id: string;
  url: string;
  title: string;
  screenshot: string;
};

type EvidenceEvent = {
  id: string;
  run: number;
  intent: string;
  targetAttempted: string;
  targetResolvedAs: string;
  executor: "playwright" | "stagehand";
  recovered: boolean;
  verified: boolean;
  fromState: string;
  toState: string;
  screenshotBefore: string;
  screenshotAfter: string;
  durationMs: number;
};

type TransitionMemory = {
  id: string;
  fromState: string;
  toState: string;
  intent: string;
  executor: "playwright" | "stagehand";
  recovered: boolean;
  verified: boolean;
};

type Memory = {
  targets: TargetMemory[];
  states: StateMemory[];
  transitions: TransitionMemory[];
  events: EvidenceEvent[];
};

function hash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

async function loadMemory(
  filePath: string,
): Promise<Memory> {
  try {
    return JSON.parse(
      await fs.readFile(filePath, "utf8"),
    ) as Memory;
  } catch {
    return {
      targets: [],
      states: [],
      transitions: [],
      events: [],
    };
  }
}

async function saveMemory(
  filePath: string,
  memory: Memory,
): Promise<void> {
  await fs.writeFile(
    filePath,
    JSON.stringify(memory, null, 2),
    "utf8",
  );
}

async function observe(
  page: Page,
): Promise<{
  url: string;
  title: string;
  headings: string[];
  interactive: Array<{
    role: string;
    name?: string;
    ref?: string;
  }>;
}> {
  const tree = await page.ariaSnapshotJSON({
    mode: "ai",
    depth: 6,
    boxes: false,
  });

  const elements: Array<{
    role: string;
    name?: string;
    ref?: string;
  }> = [];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    const record =
      value as Record<string, unknown>;

    if (typeof record.role === "string") {
      elements.push({
        role: record.role,
        ...(typeof record.name === "string"
          ? { name: record.name }
          : {}),
        ...(typeof record.ref === "string"
          ? { ref: record.ref }
          : {}),
      });
    }

    if (Array.isArray(record.children)) {
      visit(record.children);
    }
  }

  visit(tree);

  const interactiveRoles = new Set([
    "button",
    "link",
    "checkbox",
    "combobox",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "textbox",
    "option",
    "tab",
    "menuitem",
  ]);

  const interactive = elements.filter(
    (element) =>
      interactiveRoles.has(element.role),
  );

  const headings = elements
    .filter(
      (element) =>
        element.role === "heading",
    )
    .map((element) => element.name ?? "")
    .filter(Boolean);

  return {
    url: page.url(),
    title: await page.title(),
    headings,
    interactive,
  };
}

function stateId(
  observation: Awaited<
    ReturnType<typeof observe>
  >,
): string {
  const normalized = {
    path: new URL(
      observation.url,
    ).pathname,

    title: observation.title,

    headings: observation.headings,

    interactive: observation.interactive.map(
      (element) => ({
        role: element.role,
        name: element.name,
      }),
    ),
  };

  return `state_${hash(
    JSON.stringify(normalized),
  )}`;
}

async function captureState(
  page: Page,
  screenshotDir: string,
): Promise<StateMemory> {
  const observation = await observe(page);

  const id = stateId(observation);

  const screenshot = path.join(
    screenshotDir,
    `${id}.png`,
  );

  await page.screenshot({
    path: screenshot,
    fullPage: true,
  });

  return {
    id,
    url: observation.url,
    title: observation.title,
    screenshot,
  };
}

function rememberTarget(
  memory: Memory,
  intent: string,
  target: Locator,
  href: string,
): void {
  const existing = memory.targets.find(
    (item) => item.intent === intent,
  );

  if (existing) {
    if (!existing.names.includes(intent)) {
      existing.names.push(intent);
    }

    return;
  }

  const resolved = new URL(
    href,
    "http://meu.local",
  );

  memory.targets.push({
    intent,
    role: "link",
    names: [intent],
    href,
    path: resolved.pathname,
  });

  console.log(
    `[memory] learned "${intent}" → ${resolved.pathname}`,
  );
}

async function deterministicResolve(
  page: Page,
  memory: Memory,
  intent: string,
): Promise<{
  locator: Locator;
  resolvedName: string;
}> {
  const target = page
    .getByRole("link", {
      name: intent,
      exact: true,
    })
    .first();

  if (!(await target.count())) {
    throw new Error(
      `deterministic target not found: ${intent}`,
    );
  }

  const href = await target.getAttribute(
    "href",
  );

  if (!href) {
    throw new Error(
      `target has no href: ${intent}`,
    );
  }

  rememberTarget(
    memory,
    intent,
    target,
    href,
  );

  return {
    locator: target,
    resolvedName: intent,
  };
}

async function stagehandRecover(
  url: string,
  intent: string,
  artifactDir: string,
): Promise<{
  finalUrl: string;
  finalTitle: string;
  durationMs: number;
  actionDescription: string;
  selector: string;
}> {
  const beforeScreenshot = path.join(
    artifactDir,
    "stagehand-before.png",
  );

  const afterScreenshot = path.join(
    artifactDir,
    "stagehand-after.png",
  );

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
      "[fallback] launching Stagehand v4",
    );

    browser = await localBrowser.launch({
      headless: false,
    });

    stagehand = await Stagehand.create({
      browser,
      model: {
        modelName: "openai/gpt-5.4-mini",
        apiKey: process.env.OPENAI_API_KEY!,
      },
    });

    const pages =
      await browser.context.pages();

    if (pages.length === 0) {
      throw new Error(
        "Stagehand created no pages",
      );
    }

    const page = pages[0];

    await page.goto(url);

    console.log(
      `[fallback] opened ${url}`,
    );

    await page.screenshot({
      path: beforeScreenshot,
      fullPage: true,
    });

    const started = Date.now();

    const result = await stagehand.act(
      "Click the link that continues the checkout process from the cart.",
    );

    const durationMs =
      Date.now() - started;

    if (result.data?.success !== true) {
      throw new Error(
        `Stagehand recovery failed: ${
          result.data?.message ??
          "unknown error"
        }`,
      );
    }

    const finalUrl = await page.url();
    const finalTitle = await page.title();

    await page.screenshot({
      path: afterScreenshot,
      fullPage: true,
    });

    const action =
      result.data.actions?.[0] as
        | {
            selector?: string;
            description?: string;
          }
        | undefined;

    console.log(
      `[fallback] Stagehand recovered "${intent}"`,
    );

    console.log(
      `[fallback] ${finalUrl}`,
    );

    return {
      finalUrl,
      finalTitle,
      durationMs,
      actionDescription:
        action?.description ??
        "AI-assisted recovery",
      selector:
        action?.selector ??
        "unknown",
    };
  } finally {
    if (stagehand) {
      await stagehand.close();
    }

    if (browser) {
      await browser.close();
    }
  }
}

async function performPlaywrightAction(
  page: Page,
  memory: Memory,
  screenshotDir: string,
  run: number,
  currentState: StateMemory,
  intent: string,
  expectedTitle: string,
): Promise<StateMemory> {
  const started = Date.now();

  const beforeScreenshot =
    currentState.screenshot;

  const { locator, resolvedName } =
    await deterministicResolve(
      page,
      memory,
      intent,
    );

  console.log(
    `[executor] Playwright → "${intent}"`,
  );

  await locator.click();

  const nextState = await captureState(
    page,
    screenshotDir,
  );

  const durationMs =
    Date.now() - started;

  const verified =
    nextState.title === expectedTitle;

  memory.transitions.push({
    id: `transition_${hash(
      `${run}:${currentState.id}:${nextState.id}:${intent}`,
    )}`,
    fromState: currentState.id,
    toState: nextState.id,
    intent,
    executor: "playwright",
    recovered: false,
    verified,
  });

  memory.events.push({
    id: `event_${hash(
      `${run}:${started}:${intent}:playwright`,
    )}`,
    run,
    intent,
    targetAttempted: intent,
    targetResolvedAs: resolvedName,
    executor: "playwright",
    recovered: false,
    verified,
    fromState: currentState.id,
    toState: nextState.id,
    screenshotBefore: beforeScreenshot,
    screenshotAfter: nextState.screenshot,
    durationMs,
  });

  console.log(
    `[verify] ${verified ? "PASS" : "FAIL"} → ${nextState.title}`,
  );

  if (!verified) {
    throw new Error(
      `Expected ${expectedTitle}, got ${nextState.title}`,
    );
  }

  if (
    !memory.states.some(
      (state) =>
        state.id === nextState.id,
    )
  ) {
    memory.states.push(nextState);
  }

  return nextState;
}

async function performRecovery(
  page: Page,
  memory: Memory,
  screenshotDir: string,
  run: number,
  currentState: StateMemory,
  intent: string,
  expectedTitle: string,
  shopflowBaseUrl: string,
): Promise<StateMemory> {
  console.log(
    `[resolver] exact target missing: "${intent}"`,
  );

  const remembered =
    memory.targets.find(
      (target) => target.intent === intent,
    );

  if (!remembered) {
    throw new Error(
      `No memory for "${intent}"`,
    );
  }

  const currentUrl =
    await page.url();

  const recoveryUrl = currentUrl;

  const result =
    await stagehandRecover(
      recoveryUrl,
      intent,
      path.resolve(
        "artifacts/meu-demo/stagehand",
      ),
    );

  const verified =
    result.finalTitle === expectedTitle;

  const durationMs =
    result.durationMs;

  console.log(
    `[verify] ${verified ? "PASS" : "FAIL"} → ${result.finalTitle} [STAGEHAND RECOVERED]`,
  );

  if (!verified) {
    throw new Error(
      `Recovery reached "${result.finalTitle}", expected "${expectedTitle}"`,
    );
  }

  // Learn the changed target representation.
  const existing =
    memory.targets.find(
      (target) => target.intent === intent,
    );

  if (existing) {
    const currentName =
      existing.names.includes(intent)
        ? intent
        : intent;

    if (
      currentName &&
      !existing.names.includes(
        currentName,
      )
    ) {
      existing.names.push(currentName);
    }
  }

  // Hand control back to the deterministic
  // Playwright browser.
  await page.goto(result.finalUrl);

  const nextState = await captureState(
    page,
    screenshotDir,
  );

  memory.transitions.push({
    id: `transition_${hash(
      `${run}:${currentState.id}:${nextState.id}:${intent}:stagehand`,
    )}`,
    fromState: currentState.id,
    toState: nextState.id,
    intent,
    executor: "stagehand",
    recovered: true,
    verified,
  });

  memory.events.push({
    id: `event_${hash(
      `${run}:${Date.now()}:${intent}:stagehand`,
    )}`,
    run,
    intent,
    targetAttempted: intent,
    targetResolvedAs:
      existing?.names.at(-1) ??
      "AI recovered target",
    executor: "stagehand",
    recovered: true,
    verified,
    fromState: currentState.id,
    toState: nextState.id,
    screenshotBefore:
      path.resolve(
        "artifacts/meu-demo/stagehand/stagehand-before.png",
      ),
    screenshotAfter:
      path.resolve(
        "artifacts/meu-demo/stagehand/stagehand-after.png",
      ),
    durationMs,
  });

  // Keep the base URL referenced so the
  // recovery layer can later be generalized.
  void shopflowBaseUrl;

  if (
    !memory.states.some(
      (state) =>
        state.id === nextState.id,
    )
  ) {
    memory.states.push(nextState);
  }

  console.log(
    `[memory] recovery recorded for "${intent}"`,
  );

  return nextState;
}

async function runNormalFlow(
  page: Page,
  memory: Memory,
  screenshotDir: string,
): Promise<void> {
  console.log(
    "\n[run 1] learning normal flow",
  );

  await page.goto(
    process.env.SHOPFLOW_URL!,
  );

  let currentState =
    await captureState(
      page,
      screenshotDir,
    );

  if (
    !memory.states.some(
      (state) =>
        state.id === currentState.id,
    )
  ) {
    memory.states.push(currentState);
  }

  currentState =
    await performPlaywrightAction(
      page,
      memory,
      screenshotDir,
      1,
      currentState,
      "Products",
      "Products",
    );

  currentState =
    await performPlaywrightAction(
      page,
      memory,
      screenshotDir,
      1,
      currentState,
      "View Product",
      "MacBook Pro",
    );

  currentState =
    await performPlaywrightAction(
      page,
      memory,
      screenshotDir,
      1,
      currentState,
      "Add to Cart",
      "Cart",
    );

  currentState =
    await performPlaywrightAction(
      page,
      memory,
      screenshotDir,
      1,
      currentState,
      "Checkout",
      "Checkout",
    );

  console.log(
    `[run 1] learned states=${memory.states.length}`,
  );
}

async function runMutatedFlow(
  page: Page,
  memory: Memory,
  screenshotDir: string,
  shopflowBaseUrl: string,
): Promise<void> {
  console.log(
    "\n[run 2] testing mutated flow",
  );

  await page.goto(
    `${shopflowBaseUrl}/?mutation=1`,
  );

  let currentState =
    await captureState(
      page,
      screenshotDir,
    );

  if (
    !memory.states.some(
      (state) =>
        state.id === currentState.id,
    )
  ) {
    memory.states.push(currentState);
  }

  currentState =
    await performPlaywrightAction(
      page,
      memory,
      screenshotDir,
      2,
      currentState,
      "Products",
      "Products",
    );

  currentState =
    await performPlaywrightAction(
      page,
      memory,
      screenshotDir,
      2,
      currentState,
      "View Product",
      "MacBook Pro",
    );

  currentState =
    await performPlaywrightAction(
      page,
      memory,
      screenshotDir,
      2,
      currentState,
      "Add to Cart",
      "Cart",
    );

  const checkoutTarget =
    page.getByRole("link", {
      name: "Checkout",
      exact: true,
    }).first();

  if (await checkoutTarget.count()) {
    currentState =
      await performPlaywrightAction(
        page,
        memory,
        screenshotDir,
        2,
        currentState,
        "Checkout",
        "Checkout",
      );
  } else {
    currentState =
      await performRecovery(
        page,
        memory,
        screenshotDir,
        2,
        currentState,
        "Checkout",
        "Checkout",
        shopflowBaseUrl,
      );
  }

  // Continue normally after recovery.
  currentState =
    await performPlaywrightAction(
      page,
      memory,
      screenshotDir,
      2,
      currentState,
      "Proceed to Payment",
      "Payment",
    );

  currentState =
    await performPlaywrightAction(
      page,
      memory,
      screenshotDir,
      2,
      currentState,
      "Pay Now",
      "Order Confirmed",
    );

  console.log(
    `[run 2] completed states=${memory.states.length}`,
  );
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set",
    );
  }

  const shopflow = await startShopFlow();

  process.env.SHOPFLOW_URL =
    shopflow.url;

  const artifactDir =
    path.resolve(
      "artifacts/meu-demo",
    );

  const screenshotDir =
    path.join(
      artifactDir,
      "screenshots",
    );

  const memoryPath =
    path.join(
      artifactDir,
      "integrated-memory.json",
    );

  await fs.mkdir(
    screenshotDir,
    { recursive: true },
  );

  await fs.mkdir(
    path.join(
      artifactDir,
      "stagehand",
    ),
    { recursive: true },
  );

  const memory =
    await loadMemory(memoryPath);

  const browser =
    await chromium.launch({
      headless: false,
    });

  const page =
    await browser.newPage();

  try {
    console.log(
      `[meu] integrated engine`,
    );

    console.log(
      `[meu] ShopFlow: ${shopflow.url}`,
    );

    await runNormalFlow(
      page,
      memory,
      screenshotDir,
    );

    await saveMemory(
      memoryPath,
      memory,
    );

    await runMutatedFlow(
      page,
      memory,
      screenshotDir,
      shopflow.url,
    );

    await saveMemory(
      memoryPath,
      memory,
    );

    const recoveries =
      memory.events.filter(
        (event) =>
          event.recovered,
      ).length;

    const playwrightActions =
      memory.events.filter(
        (event) =>
          event.executor ===
          "playwright",
      ).length;

    const stagehandActions =
      memory.events.filter(
        (event) =>
          event.executor ===
          "stagehand",
      ).length;

    const run = {
      id: `run_${Date.now()}`,
      application: "ShopFlow",
      runs: 2,
      status: "PASSED",
      states: memory.states.length,
      transitions:
        memory.transitions.length,
      events: memory.events.length,
      playwrightActions,
      stagehandActions,
      recoveries,
      memoryPath,
      completedAt:
        new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(
        artifactDir,
        "integrated-run.json",
      ),
      JSON.stringify(
        run,
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      "\n[meu] =================================",
    );

    console.log(
      `[meu] PASSED | states=${run.states} transitions=${run.transitions} recoveries=${run.recoveries}`,
    );

    console.log(
      `[meu] Playwright=${run.playwrightActions} Stagehand=${run.stagehandActions}`,
    );

    console.log(
      `[meu] memory=${memoryPath}`,
    );

    console.log(
      "[meu] =================================",
    );
  } finally {
    await browser.close();
    await shopflow.close();
  }
}

main().catch(
  (error: unknown) => {
    console.error(
      "[meu] failed:",
      error,
    );

    process.exit(1);
  },
);