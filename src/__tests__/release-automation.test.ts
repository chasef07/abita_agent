import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowDirectory = resolve(
  import.meta.dirname,
  "../..",
  ".github",
  "workflows",
);

interface WorkflowJob {
  if?: string;
  needs?: string[];
  uses?: string;
  with?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Array<{
    uses?: string;
    run?: string;
    with?: Record<string, string>;
  }>;
}

interface Workflow {
  on?: {
    workflow_run?: {
      workflows?: string[];
      types?: string[];
    };
  };
  jobs?: Record<string, WorkflowJob>;
}

function readWorkflow(name: string): Workflow {
  return parse(
    readFileSync(resolve(workflowDirectory, name), "utf8"),
  ) as Workflow;
}

describe("release automation", () => {
  it("runs release automation only after successful CI on main", () => {
    const ci = readWorkflow("ci.yml");
    const release = readWorkflow("release.yml");
    const releasePlease = release.jobs?.["release-please"];

    expect(ci.jobs?.verify).toMatchObject({
      uses: "./.github/workflows/verify.yml",
      with: { release_sha: "${{ github.sha }}" },
    });
    expect(release.on?.workflow_run).toEqual({
      workflows: ["CI"],
      types: ["completed"],
    });
    expect(releasePlease?.if).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(releasePlease?.if).toContain(
      "github.event.workflow_run.event == 'push'",
    );
    expect(releasePlease?.if).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
  });

  it("deploys only the exact commit published by Release Please", () => {
    const release = readWorkflow("release.yml");
    const releasePlease = release.jobs?.["release-please"];
    const verifyRelease = release.jobs?.["verify-release"];
    const deploy = release.jobs?.deploy;
    const checkout = deploy?.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    expect(releasePlease?.outputs).toEqual({
      release_created: "${{ steps.release.outputs.release_created }}",
      release_sha: "${{ steps.release.outputs.sha }}",
    });
    expect(verifyRelease).toMatchObject({
      if: "needs.release-please.outputs.release_created == 'true'",
      needs: ["release-please"],
      uses: "./.github/workflows/verify.yml",
      with: {
        release_sha: "${{ needs.release-please.outputs.release_sha }}",
      },
    });
    expect(deploy).toMatchObject({
      if: "needs.release-please.outputs.release_created == 'true'",
      needs: ["release-please", "verify-release"],
    });
    expect(checkout?.with?.ref).toBe(
      "${{ needs.release-please.outputs.release_sha }}",
    );
  });

  it("has exactly one release-gated LiveKit deployment job", () => {
    const deploymentJobs = readdirSync(workflowDirectory)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .flatMap((workflowName) => {
        const workflow = readWorkflow(workflowName);
        return Object.entries(workflow.jobs ?? {})
          .filter(([, job]) =>
            job.steps?.some((step) => step.run?.includes("lk agent deploy")),
          )
          .map(([jobName]) => ({ workflowName, jobName }));
      });

    expect(deploymentJobs).toEqual([
      { workflowName: "release.yml", jobName: "deploy" },
    ]);
  });
});
