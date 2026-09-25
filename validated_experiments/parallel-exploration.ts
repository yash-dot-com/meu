import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright";

import {
  localBrowser,
  Stagehand,
} from "@browserbasehq/stagehand";

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  startShopFlow,
} from "./shopflow.js";

import {
  MEURuntime,
  type StateRecord,
} from "./meu-runtime.js";

type StagehandCandidate = {
  selector: string;
  description?: string;
  method?: string;
  arguments?: unknown[];
};

type Candidate = {
  key: string;
  intent: string;
  selector: string;
  description: string;
  path?: string;
};

type EdgeStatus =
  | "UNKNOWN"
  | "RESERVED"
  | "VERIFIED"
  | "FAILED";

type Edge = {
  key: string;
  fromStateId: string;

  intent: string;
  selector: string;
  description: string;
  path?: string;

  status: EdgeStatus;

  reservedBy?: string;
  reservedAt?: string;

  traversals: number;
  toStateId?: string;
  lastRunId?: string;
};

type AgentResult = {
  agentId: string;
  status:
    | "COMPLETED"
    | "IDLE"
    | "FAILED";

  edge?: string;
  fromState?: string;
  toState?: string;

  durationMs?: number;

  screenshotBefore?: string;
  screenshotAfter?: string;

  error?: string;
};

type PathRecord = {
  agentId: string;
  stateIds: string[];
  edgeKeys: string[];
  signature: string;
};

type Summary = {
  experiment: "S5";

  frontierState: StateRecord;

  candidates: Candidate[];

  edges: Edge[];

  agents: AgentResult[];

  paths: PathRecord[];

  reservationBlocks: number;

  createdAt: string;
};

function shortHash(
  value: string,
): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Convert Stagehand's natural-language description
 * into a stable MEU action intent.
 *
 * The prompt asks Stagehand to include:
 * ACTION: <canonical name>
 *
 * This keeps the adapter simple tonight.
 *
 * A production version can replace this with a
 * proper action-normalization model.
 */
function canonicalIntent(
  description: string,
): string {
  const match =
    description.match(
      /ACTION:\s*([^—-]+)/i,
    );

  if (match?.[1]) {
    return match[1].trim();
  }

  const normalized =
    description.toLowerCase();

  if (
    normalized.includes("add") &&
    normalized.includes("cart")
  ) {
    return "Add to Cart";
  }

  if (
    normalized.includes("wishlist")
  ) {
    return "Wishlist";
  }

  if (
    normalized.includes("view") &&
    normalized.includes("product")
  ) {
    return "View Product";
  }

  if (
    normalized.includes("checkout")
  ) {
    return "Checkout";
  }

  if (
    normalized.includes("pay now")
  ) {
    return "Pay Now";
  }

  return description.trim();
}

/**
 * Stagehand v4 wraps primitive results:
 *
 * {
 *   data,
 *   metadata
 * }
 *
 * Depending on protocol/result representation,
 * data may be the array directly or contain result.
 */
function extractObserveResults(
  value: unknown,
): StagehandCandidate[] {
  if (Array.isArray(value)) {
    return value as StagehandCandidate[];
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const record =
      value as Record<
        string,
        unknown
      >;

    if (
      Array.isArray(
        record.result,
      )
    ) {
      return record.result as StagehandCandidate[];
    }

    if (
      Array.isArray(
        record.actions,
      )
    ) {
      return record.actions as StagehandCandidate[];
    }
  }

  return [];
}

class ExplorationCoordinator {
  private readonly edges =
    new Map<string, Edge>();

  private reservationBlocks = 0;

  addCandidate(
    candidate: Candidate,
    fromStateId: string,
    knownActions: Set<string>,
  ): void {
    const existing =
      this.edges.get(candidate.key);

    if (existing) {
      return;
    }

    const known =
      knownActions.has(
        candidate.intent,
      );

    this.edges.set(
      candidate.key,
      {
        key: candidate.key,
        fromStateId,

        intent:
          candidate.intent,

        selector:
          candidate.selector,

        description:
          candidate.description,

        ...(candidate.path
          ? {
              path:
                candidate.path,
            }
          : {}),

        status:
          known
            ? "VERIFIED"
            : "UNKNOWN",

        traversals:
          known
            ? 1
            : 0,
      },
    );
  }

  claimNext(
    agentId: string,
    stateId: string,
  ): Edge | null {
    for (
      const edge of
      this.edges.values()
    ) {
      if (
        edge.fromStateId !==
        stateId
      ) {
        continue;
      }

      if (
        edge.status !==
        "UNKNOWN"
      ) {
        this.reservationBlocks++;
        continue;
      }

      edge.status =
        "RESERVED";

      edge.reservedBy =
        agentId;

      edge.reservedAt =
        new Date().toISOString();

      return {
        ...edge,
      };
    }

    return null;
  }

  complete(
    edgeKey: string,
    agentId: string,
    toStateId: string,
    runId: string,
  ): void {
    const edge =
      this.edges.get(
        edgeKey,
      );

    if (!edge) {
      throw new Error(
        `Unknown edge: ${edgeKey}`,
      );
    }

    if (
      edge.reservedBy !==
      agentId
    ) {
      throw new Error(
        `Agent ${agentId} does not own ${edgeKey}`,
      );
    }

    edge.status =
      "VERIFIED";

    edge.toStateId =
      toStateId;

    edge.traversals++;

    edge.lastRunId =
      runId;
  }

  fail(
    edgeKey: string,
    agentId: string,
    runId: string,
  ): void {
    const edge =
      this.edges.get(
        edgeKey,
      );

    if (!edge) {
      throw new Error(
        `Unknown edge: ${edgeKey}`,
      );
    }

    if (
      edge.reservedBy !==
      agentId
    ) {
      throw new Error(
        `Agent ${agentId} does not own ${edgeKey}`,
      );
    }

    edge.status =
      "FAILED";

    edge.traversals++;

    edge.lastRunId =
      runId;
  }

  getEdges(): Edge[] {
    return [
      ...this.edges.values(),
    ].map((edge) => ({
      ...edge,
    }));
  }

  getReservationBlocks(): number {
    return this.reservationBlocks;
  }
}

async function discoverCandidates(
  stagehand:
    Awaited<
      ReturnType<
        typeof Stagehand.create
      >
    >,
): Promise<Candidate[]> {
  const instruction = [
    "Find meaningful state-changing user actions",
    "inside the main application content.",
    "Ignore global navigation, Home, Products,",
    "footer links, language links, and settings.",
    "",
    "For every useful action, return a description",
    "starting with `ACTION: <short canonical action name> —`",
    "followed by a useful explanation.",
    "",
    "Examples:",
    "ACTION: Add to Cart — add this product to the cart.",
    "ACTION: Wishlist — save this product to the wishlist.",
    "ACTION: View Product — open product details.",
  ].join("\n");

  console.log(
    "[discovery] Stagehand observing meaningful actions once",
  );

  const response =
    await stagehand.observe(
      instruction,
    );

  const candidates =
    extractObserveResults(
      response.data,
    );

  console.log(
    `[discovery] raw candidates=${candidates.length}`,
  );

  const normalized: Candidate[] =
    [];

  for (
    const candidate of
    candidates
  ) {
    if (
      !candidate.selector
    ) {
      continue;
    }

    const description =
      (
        candidate.description ??
        ""
      ).trim();

    if (!description) {
      continue;
    }

    const intent =
      canonicalIntent(
        description,
      );

    if (!intent) {
      continue;
    }

    /*
     * We deliberately derive path later from
     * the actual Playwright execution page.
     *
     * The Stagehand selector itself is preserved
     * as the AI-discovered targeting evidence.
     */
    const key =
      `${intent}:${candidate.selector}`;

    if (
      normalized.some(
        (item) =>
          item.key === key,
      )
    ) {
      continue;
    }

    normalized.push({
      key,
      intent,
      selector:
        candidate.selector,
      description,
    });
  }

  return normalized;
}

async function executeEdge(
  context: BrowserContext,
  agentId: string,
  edge: Edge,
  baseUrl: string,
  runtime: MEURuntime,
): Promise<
  AgentResult & {
    path: PathRecord;
  }
> {
  const runId =
    `run_${agentId}_${Date.now()}`;

  const page =
    await context.newPage();

  const started =
    Date.now();

  try {
    console.log(
      `[${agentId}] executing "${edge.intent}"`,
    );

    await page.goto(
      `${baseUrl}/product/1`,
    );

    const before =
      await runtime.captureState(
        page,
      );

    /*
     * Critical architecture:
     *
     * Stagehand discovered the selector.
     * Playwright executes that selector.
     *
     * The workers do NOT call Stagehand again.
     */
    const target =
      page.locator(
        edge.selector,
      ).first();

    if (
      !(await target.count())
    ) {
      throw new Error(
        `Stagehand selector unavailable in Playwright: ${edge.selector}`,
      );
    }

    await target.click();

    const after =
      await runtime.captureState(
        page,
      );

    const verified =
      after.id !== before.id;

    const durationMs =
      Date.now() - started;

    runtime.recordTransition({
      fromState:
        before.id,

      toState:
        after.id,

      intent:
        edge.intent,

      target:
        edge.intent,

      executor:
        "playwright",

      recovered:
        false,

      verified,

      durationMs,
    });

    runtime.recordEvent({
      runId,

      type:
        "exploration",

      intent:
        edge.intent,

      target:
        edge.intent,

      executor:
        "playwright",

      fromState:
        before.id,

      toState:
        after.id,

      screenshotBefore:
        before.screenshot,

      screenshotAfter:
        after.screenshot,

      verified,

      recovered:
        false,

      metadata: {
        agentId,
        edgeKey:
          edge.key,

        stagehandDescription:
          edge.description,

        stagehandSelector:
          edge.selector,

        pathSignature:
          `${before.id}>${edge.key}>${after.id}`,
      },
    });

    if (!verified) {
      throw new Error(
        `Action did not create a new state: ${edge.intent}`,
      );
    }

    console.log(
      `[${agentId}] VERIFIED "${edge.intent}" → ${after.title}`,
    );

    return {
      agentId,
      status:
        "COMPLETED",

      edge:
        edge.key,

      fromState:
        before.id,

      toState:
        after.id,

      durationMs,

      screenshotBefore:
        before.screenshot,

      screenshotAfter:
        after.screenshot,

      path: {
        agentId,

        stateIds: [
          before.id,
          after.id,
        ],

        edgeKeys: [
          edge.key,
        ],

        signature:
          `${before.id}>${edge.key}>${after.id}`,
      },
    };
  } catch (
    error: unknown
  ) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `[${agentId}] FAILED: ${message}`,
    );

    return {
      agentId,

      status:
        "FAILED",

      edge:
        edge.key,

      durationMs:
        Date.now() - started,

      error:
        message,

      path: {
        agentId,
        stateIds: [],
        edgeKeys: [],
        signature: "",
      },
    };
  } finally {
    await page.close();
  }
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
      "artifacts/meu-demo/shared-exploration",
    );

  const screenshotDir =
    path.join(
      artifactDir,
      "screenshots",
    );

  const memoryPath =
    path.join(
      artifactDir,
      "memory.json",
    );

  await fs.mkdir(
    screenshotDir,
    {
      recursive: true,
    },
  );

  const runtime =
    new MEURuntime({
      memoryPath,
      screenshotDir,
    });

  await runtime.load();

  runtime.clear();

  const executionBrowser =
    await chromium.launch({
      headless: false,
    });

  let discoveryBrowser:
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
      `[s5] ShopFlow=${shopflow.url}`,
    );

    // =================================================
    // 1. Create canonical frontier state
    // =================================================

    const seedContext =
      await executionBrowser.newContext();

    const seedPage =
      await seedContext.newPage();

    await seedPage.goto(
      `${shopflow.url}/product/1`,
    );

    const productState =
      await runtime.captureState(
        seedPage,
      );

    console.log(
      `[s5] canonical frontier=${productState.id}`,
    );

    // =================================================
    // 2. Seed one known edge through real Playwright
    // =================================================

    const addToCart =
      seedPage.getByRole(
        "link",
        {
          name:
            "Add to Cart",
          exact: true,
        },
      );

    if (
      !(await addToCart.count())
    ) {
      throw new Error(
        "Could not find Add to Cart",
      );
    }

    const transitionStarted =
      Date.now();

    await addToCart.click();

    const cartState =
      await runtime.captureState(
        seedPage,
      );

    runtime.recordTransition({
      fromState:
        productState.id,

      toState:
        cartState.id,

      intent:
        "Add to Cart",

      target:
        "Add to Cart",

      executor:
        "playwright",

      recovered:
        false,

      verified:
        cartState.title ===
        "Cart",

      durationMs:
        Date.now() -
        transitionStarted,
    });

    await seedContext.close();

    await runtime.save();

    console.log(
      "[s5] seeded known edge: Add to Cart",
    );

    // =================================================
    // 3. Stagehand observes ONCE
    // =================================================

    discoveryBrowser =
      await localBrowser.launch({
        headless: false,
      });

    stagehand =
      await Stagehand.create({
        browser:
          discoveryBrowser,

        model: {
          modelName:
            "openai/gpt-5.4-mini",

          apiKey,
        },
      });

    const discoveryPages =
      await discoveryBrowser
        .context
        .pages();

    if (
      discoveryPages.length ===
      0
    ) {
      throw new Error(
        "No Stagehand discovery page",
      );
    }

    const discoveryPage =
      discoveryPages[0];

    await discoveryPage.goto(
      `${shopflow.url}/product/1`,
    );

    const candidates =
      await discoverCandidates(
        stagehand,
      );

    for (
      const candidate of
      candidates
    ) {
      console.log(
        `[discovery] ${candidate.intent}`,
      );
    }

    // =================================================
    // 4. Build shared graph frontier
    // =================================================

    const knownActions =
      new Set(
        runtime.getKnownActions(
          productState.id,
        ),
      );

    console.log(
      `[graph] known=${[...knownActions].join(", ") || "none"}`,
    );

    const coordinator =
      new ExplorationCoordinator();

    for (
      const candidate of
      candidates
    ) {
      coordinator.addCandidate(
        candidate,
        productState.id,
        knownActions,
      );
    }

    console.log(
      "\n[frontier]",
    );

    for (
      const edge of
      coordinator.getEdges()
    ) {
      console.log(
        `[frontier] ${edge.intent}=${edge.status}`,
      );
    }

    // =================================================
    // 5. Multiple workers claim shared frontier
    // =================================================

    const agentIds = [
      "agent-A",
      "agent-B",
      "agent-C",
    ];

    const contexts =
      await Promise.all(
        agentIds.map(
          () =>
            executionBrowser.newContext(),
        ),
      );

    const agentPromises =
      contexts.map(
        async (
          context,
          index,
        ) => {
          const agentId =
            agentIds[index];

          const edge =
            coordinator.claimNext(
              agentId,
              productState.id,
            );

          if (!edge) {
            console.log(
              `[${agentId}] no unexplored edge → IDLE`,
            );

            return {
              agentId,
              status:
                "IDLE" as const,
            };
          }

          console.log(
            `[${agentId}] RESERVED "${edge.intent}"`,
          );

          const result =
            await executeEdge(
              context,
              agentId,
              edge,
              shopflow.url,
              runtime,
            );

          if (
            result.status ===
              "COMPLETED" &&
            result.toState
          ) {
            coordinator.complete(
              edge.key,
              agentId,
              result.toState,
              `run_${agentId}`,
            );
          } else {
            coordinator.fail(
              edge.key,
              agentId,
              `run_${agentId}`,
            );
          }

          return result;
        },
      );

    const agents =
      await Promise.all(
        agentPromises,
      );

    for (
      const context of
      contexts
    ) {
      await context.close();
    }

    // =================================================
    // 6. Late worker proves frontier is exhausted
    // =================================================

    const lateAgent =
      "agent-D";

    const lateContext =
      await executionBrowser.newContext();

    const lateEdge =
      coordinator.claimNext(
        lateAgent,
        productState.id,
      );

    let lateResult:
      AgentResult;

    if (!lateEdge) {
      console.log(
        `[${lateAgent}] no remaining unexplored edge → IDLE`,
      );

      lateResult = {
        agentId:
          lateAgent,

        status:
          "IDLE",
      };
    } else {
      console.log(
        `[${lateAgent}] unexpected edge="${lateEdge.intent}"`,
      );

      const result =
        await executeEdge(
          lateContext,
          lateAgent,
          lateEdge,
          shopflow.url,
          runtime,
        );

      lateResult =
        result;

      if (
        result.status ===
          "COMPLETED" &&
        result.toState
      ) {
        coordinator.complete(
          lateEdge.key,
          lateAgent,
          result.toState,
          `run_${lateAgent}`,
        );
      }
    }

    await lateContext.close();

    // =================================================
    // 7. Save results
    // =================================================

    const allAgents = [
      ...agents,
      lateResult,
    ];

    const paths =
      allAgents
        .filter(
          (
            result,
          ): result is AgentResult & {
            path: PathRecord;
          } =>
            result.path !==
              undefined &&
            result.path.stateIds
              .length > 0,
        )
        .map(
          (result) =>
            result.path,
        );

    const edges =
      coordinator.getEdges();

    const summary:
      Summary =
      {
        experiment:
          "S5",

        frontierState:
          productState,

        candidates,

        edges,

        agents:
          allAgents,

        paths,

        reservationBlocks:
          coordinator.getReservationBlocks(),

        createdAt:
          new Date().toISOString(),
      };

    await fs.writeFile(
      path.join(
        artifactDir,
        "shared-exploration.json",
      ),
      JSON.stringify(
        summary,
        null,
        2,
      ),
      "utf8",
    );

    await runtime.save();

    // =================================================
    // 8. Validation
    // =================================================

    const knownEdge =
      edges.find(
        (edge) =>
          edge.intent ===
          "Add to Cart",
      );

    const newEdge =
      edges.find(
        (edge) =>
          edge.intent ===
          "Wishlist",
      );

    const completedAgents =
      allAgents.filter(
        (agent) =>
          agent.status ===
          "COMPLETED",
      );

    const idleAgents =
      allAgents.filter(
        (agent) =>
          agent.status ===
          "IDLE",
      );

    console.log(
      "\n[s5] =====================================",
    );

    console.log(
      `[s5] candidates=${candidates.length}`,
    );

    console.log(
      `[s5] verifiedEdges=${
        edges.filter(
          (edge) =>
            edge.status ===
            "VERIFIED",
        ).length
      }`,
    );

    console.log(
      `[s5] completedAgents=${completedAgents.length}`,
    );

    console.log(
      `[s5] idleAgents=${idleAgents.length}`,
    );

    console.log(
      `[s5] reservationBlocks=${
        coordinator.getReservationBlocks()
      }`,
    );

    console.log(
      `[s5] paths=${paths.length}`,
    );

    console.log(
      `[s5] evidence=${artifactDir}`,
    );

    console.log(
      "[s5] =====================================",
    );

    if (!knownEdge) {
      throw new Error(
        "Known Add to Cart edge was not discovered.",
      );
    }

    if (
      knownEdge.status !==
      "VERIFIED"
    ) {
      throw new Error(
        "Known Add to Cart edge was not recognized as already traversed.",
      );
    }

    if (!newEdge) {
      throw new Error(
        "Wishlist was not discovered.",
      );
    }

    if (
      newEdge.status !==
      "VERIFIED"
    ) {
      throw new Error(
        "Wishlist was not successfully explored.",
      );
    }

    /*
     * Exactly one worker should get the only new edge.
     */
    if (
      completedAgents.length !==
      1
    ) {
      throw new Error(
        `Expected 1 worker to execute new work, got ${completedAgents.length}.`,
      );
    }

    /*
     * The other 3 workers should find no new work.
     */
    if (
      idleAgents.length !==
      3
    ) {
      throw new Error(
        `Expected 3 idle workers, got ${idleAgents.length}.`,
      );
    }

    console.log(
      "[s5] PASS — shared graph prevented duplicate exploration",
    );
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch {
        // Cleanup.
      }
    }

    if (discoveryBrowser) {
      try {
        await discoveryBrowser.close();
      } catch {
        // Cleanup.
      }
    }

    await executionBrowser.close();

    await shopflow.close();
  }
}

main().catch(
  (error: unknown) => {
    console.error(
      "[s5] failed:",
      error,
    );

    process.exit(1);
  },
);