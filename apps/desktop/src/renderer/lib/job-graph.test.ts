import { expect, test } from "vitest";
import { jobLevels, layoutJobGraph } from "./job-graph";

const metrics = { nodeWidth: 100, nodeHeight: 40, columnGap: 20, rowGap: 10 };

test("places jobs in columns by dependency depth and keeps source order within a column", () => {
  const jobs = [
    { job: "deploy", needs: ["test", "lint"] },
    { job: "lint" },
    { job: "build", needs: [] },
    { job: "test", needs: ["build"] },
  ];
  expect(Object.fromEntries(jobLevels(jobs))).toEqual({ deploy: 2, lint: 0, build: 0, test: 1 });
  const layout = layoutJobGraph(jobs, metrics);
  expect(layout.nodes.map((node) => [node.job.job, node.x, node.y])).toEqual([
    ["lint", 0, 0],
    ["build", 0, 50],
    ["test", 120, 0],
    ["deploy", 240, 0],
  ]);
  expect(layout.width).toBe(340);
  expect(layout.height).toBe(90);
  expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([
    "build>test",
    "test>deploy",
    "lint>deploy",
  ]);
  expect(layout.edges[0]?.path).toBe("M 100 70 C 110 70, 110 20, 120 20");
});

test("ignores unknown, self, and cyclic needs without dropping jobs", () => {
  const jobs = [
    { job: "a", needs: ["b", "missing"] },
    { job: "b", needs: ["a"] },
    { job: "c", needs: ["c"] },
  ];
  const layout = layoutJobGraph(jobs, metrics);
  expect(layout.nodes.map((node) => node.job.job).sort()).toEqual(["a", "b", "c"]);
  expect(layout.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  expect(layoutJobGraph([], metrics)).toMatchObject({ nodes: [], edges: [], width: 0, height: 0 });
});
