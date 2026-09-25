import {
  chromium,
  type Locator,
  type Page,
} from "playwright";

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { startShopFlow } from "./shopflow.js";

type SemanticElement = {
  role: string;
  name?: string;
  ref?: string;
};

type Observation = {
  url: string;
  title: string;
  headings: string[];
  interactive: SemanticElement[];
};

type TargetMemory = {
  intent: string;
  role: string;
  name: string;
  href: string;
  path: string;
};

type StateMemory = {
  id: string;
  url: string;
  title: string;
  fingerprint: string;
  screenshot: string;
};

type TransitionMemory = {
  id: string;
  fromState: string;
  toState: string;
  intent: string;
  target: string;
  recovered: boolean;
};

type EvidenceEvent = {
  id: string;
  run: number;
  intent: string;
  target: string;
  targetResolvedAs: string;
  fromState: string;
  toState: string;
  screenshotBefore: string;
  screenshotAfter: string;
  verified: boolean;
  recovered: boolean;
  durationMs: number;
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

async function getAriaTree(
  page: Page,
): Promise<unknown> {
  const pageWithJson = page as Page & {
    ariaSnapshotJSON?: (options?: {
      mode?: "ai" | "default";
      depth?: number;
      boxes?: boolean;
    }) => Promise<unknown>;
  };

  if (
    typeof pageWithJson.ariaSnapshotJSON !==
    "function"
  ) {
    throw new Error(
      "Playwright ariaSnapshotJSON() is unavailable",
    );
  }

  return pageWithJson.ariaSnapshotJSON({
    mode: "ai",
    depth: 6,
    boxes: false,
  });
}

function flattenAriaTree(
  node: unknown,
): SemanticElement[] {
  const elements: SemanticElement[] = [];

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
      const element: SemanticElement = {
        role: record.role,
      };

      if (typeof record.name === "string") {
        element.name = record.name;
      }

      if (typeof record.ref === "string") {
        element.ref = record.ref;
      }

      elements.push(element);
    }

    if (Array.isArray(record.children)) {
      visit(record.children);
    }
  }

  visit(node);

  return elements;
}

async function observe(
  page: Page,
): Promise<Observation> {
  const tree = await getAriaTree(page);

  const elements = flattenAriaTree(tree);

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

  const interactive = elements.filter((element) =>
    interactiveRoles.has(element.role),
  );

  const headings = elements
    .filter(
      (element) => element.role === "heading",
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

function stateFingerprint(
  observation: Observation,
): string {
  const normalized = {
    path: new URL(observation.url).pathname,
    title: observation.title,

    interactive: observation.interactive.map(
      (element) => ({
        role: element.role,
        name: element.name,
      }),
    ),
  };

  return hash(JSON.stringify(normalized));
}

async function captureState(
  page: Page,
  screenshotDir: string,
): Promise<StateMemory> {
  const observation = await observe(page);

  const fingerprint =
    stateFingerprint(observation);

  const screenshot = path.join(
    screenshotDir,
    `${fingerprint}.png`,
  );

  await page.screenshot({
    path: screenshot,
    fullPage: true,
  });

  return {
    id: `state_${fingerprint}`,
    url: observation.url,
    title: observation.title,
    fingerprint,
    screenshot,
  };
}

async function loadMemory(
  memoryPath: string,
): Promise<Memory> {
  try {
    const content = await fs.readFile(
      memoryPath,
      "utf8",
    );

    return JSON.parse(content) as Memory;
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
  memoryPath: string,
  memory: Memory,
): Promise<void> {
  await fs.writeFile(
    memoryPath,
    JSON.stringify(memory, null, 2),
    "utf8",
  );
}

async function findLinkByPath(
  page: Page,
  expectedPath: string,
): Promise<Locator | null> {
  const links = page.locator("a");
  const count = await links.count();

  for (let index = 0; index < count; index++) {
    const link = links.nth(index);
    const href = await link.getAttribute("href");

    if (!href) {
      continue;
    }

    let resolved: URL;

    try {
      resolved = new URL(href, page.url());
    } catch {
      continue;
    }

    if (resolved.pathname === expectedPath) {
      return link;
    }
  }

  return null;
}

async function learnTarget(
  page: Page,
  intent: string,
  memory: Memory,
): Promise<Locator> {
  const target = page.getByRole("link", {
    name: intent,
    exact: true,
  }).first();

  if (!(await target.count())) {
    throw new Error(
      `Exact target not found: "${intent}"`,
    );
  }

  const href = await target.getAttribute(
    "href",
  );

  if (!href) {
    throw new Error(
      `Target "${intent}" has no href`,
    );
  }

  const resolved = new URL(
    href,
    page.url(),
  );

  const alreadyKnown = memory.targets.some(
    (targetMemory) =>
      targetMemory.intent === intent,
  );

  if (!alreadyKnown) {
    memory.targets.push({
      intent,
      role: "link",
      name: intent,
      href,
      path: resolved.pathname,
    });

    console.log(
      `[memory] learned "${intent}" → ${resolved.pathname}`,
    );
  }

  return target;
}

async function resolveTarget(
  page: Page,
  intent: string,
  memory: Memory,
): Promise<{
  locator: Locator;
  recovered: boolean;
  resolvedName: string;
}> {
  const exact = page.getByRole("link", {
    name: intent,
    exact: true,
  }).first();

  if (await exact.count()) {
    await learnTarget(
      page,
      intent,
      memory,
    );

    console.log(
      `[resolver] exact "${intent}"`,
    );

    return {
      locator: exact,
      recovered: false,
      resolvedName: intent,
    };
  }

  console.log(
    `[resolver] exact target missing: "${intent}"`,
  );

  const remembered =
    memory.targets.find(
      (target) => target.intent === intent,
    );

  if (!remembered) {
    throw new Error(
      `No remembered target for "${intent}"`,
    );
  }

  const recovered = await findLinkByPath(
    page,
    remembered.path,
  );

  if (!recovered) {
    throw new Error(
      `Could not recover "${intent}" using path "${remembered.path}"`,
    );
  }

  const resolvedName =
    ((await recovered.innerText()) || "")
      .trim();

  console.log(
    `[resolver] RECOVERED "${intent}" → "${resolvedName}"`,
  );

  return {
    locator: recovered,
    recovered: true,
    resolvedName,
  };
}

async function executeAction(
  page: Page,
  memory: Memory,
  screenshotDir: string,
  runNumber: number,
  intent: string,
  expectedTitle: string,
  currentState: StateMemory,
): Promise<StateMemory> {
  const started = Date.now();

  const result = await resolveTarget(
    page,
    intent,
    memory,
  );

  await result.locator.click();

  const nextState = await captureState(
    page,
    screenshotDir,
  );

  const verified =
    nextState.title === expectedTitle;

  const durationMs =
    Date.now() - started;

  if (
    !memory.states.some(
      (state) => state.id === nextState.id,
    )
  ) {
    memory.states.push(nextState);
  }

  memory.transitions.push({
    id: `transition_${hash(
      `${runNumber}:${currentState.id}:${nextState.id}:${intent}`,
    )}`,
    fromState: currentState.id,
    toState: nextState.id,
    intent,
    target: intent,
    recovered: result.recovered,
  });

  const beforeScreenshot =
    currentState.screenshot;

  memory.events.push({
    id: `event_${hash(
      `${runNumber}:${started}:${intent}`,
    )}`,
    run: runNumber,
    intent,
    target: intent,
    targetResolvedAs: result.resolvedName,
    fromState: currentState.id,
    toState: nextState.id,
    screenshotBefore: beforeScreenshot,
    screenshotAfter: nextState.screenshot,
    verified,
    recovered: result.recovered,
    durationMs,
  });

  console.log(
    `[verify] ${verified ? "PASS" : "FAIL"} → ${nextState.title}${result.recovered ? " [RECOVERED]" : ""}`,
  );

  if (!verified) {
    throw new Error(
      `Expected "${expectedTitle}", got "${nextState.title}"`,
    );
  }

  return nextState;
}

async function runTest(
  page: Page,
  memory: Memory,
  screenshotDir: string,
  baseUrl: string,
  runNumber: number,
  mutation: boolean,
): Promise<void> {
  const startUrl = mutation
    ? `${baseUrl}/?mutation=1`
    : `${baseUrl}/`;

  await page.goto(startUrl, {
    waitUntil: "domcontentloaded",
  });

  let currentState = await captureState(
    page,
    screenshotDir,
  );

  if (
    !memory.states.some(
      (state) => state.id === currentState.id,
    )
  ) {
    memory.states.push(currentState);
  }

  const actions = [
    {
      intent: "Products",
      expectedTitle: "Products",
    },
    {
      intent: "View Product",
      expectedTitle: "MacBook Pro",
    },
    {
      intent: "Add to Cart",
      expectedTitle: "Cart",
    },
    {
      intent: "Checkout",
      expectedTitle: "Checkout",
    },
  ];

  for (const action of actions) {
    currentState = await executeAction(
      page,
      memory,
      screenshotDir,
      runNumber,
      action.intent,
      action.expectedTitle,
      currentState,
    );
  }
}

async function main(): Promise<void> {
  const shopflow = await startShopFlow();

  const artifactDir = path.resolve(
    "artifacts/meu-demo",
  );

  const screenshotDir = path.join(
    artifactDir,
    "screenshots",
  );

  const memoryPath = path.join(
    artifactDir,
    "memory.json",
  );

  await fs.mkdir(screenshotDir, {
    recursive: true,
  });

  // Start this experiment cleanly every time.
  // This prevents stale memory from previous broken runs
  // from affecting the validation result.
  try {
    await fs.unlink(memoryPath);
    console.log("[memory] cleared previous experiment");
  } catch {
    // Memory file does not exist yet.
  }

  const memory = await loadMemory(
    memoryPath,
  );

  const browser = await chromium.launch({
    headless: false,
  });

  const page = await browser.newPage();

  try {
    console.log(
      `[meu] ShopFlow: ${shopflow.url}`,
    );

    console.log(
      "\n[run 1] learning normal application",
    );

    await runTest(
      page,
      memory,
      screenshotDir,
      shopflow.url,
      1,
      false,
    );

    await saveMemory(
      memoryPath,
      memory,
    );

    console.log(
      `\n[run 1] memory targets=${memory.targets.length} states=${memory.states.length}`,
    );

    console.log(
      "\n[run 2] testing mutated application",
    );

    const statesBeforeRun2 =
      memory.states.length;

    const eventsBeforeRun2 =
      memory.events.length;

    await runTest(
      page,
      memory,
      screenshotDir,
      shopflow.url,
      2,
      true,
    );

    await saveMemory(
      memoryPath,
      memory,
    );

    const newStates =
      memory.states.length -
      statesBeforeRun2;

    const run2Events =
      memory.events.length -
      eventsBeforeRun2;

    const recoveryCount =
      memory.events.filter(
        (event) =>
          event.run === 2 &&
          event.recovered,
      ).length;

    console.log(
      `\n[run 2] events=${run2Events} newStates=${newStates} recoveries=${recoveryCount}`,
    );

    console.log(
      `[memory] targets=${memory.targets.length} states=${memory.states.length} transitions=${memory.transitions.length}`,
    );

    console.log(
      `[memory] saved ${memoryPath}`,
    );

    console.log(
      "\n[meu] memory recovery experiment complete",
    );
  } finally {
    await browser.close();
    await shopflow.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    "[meu] failed:",
    error,
  );

  process.exit(1);
});