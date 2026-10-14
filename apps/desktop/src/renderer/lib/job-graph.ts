export interface GraphJob {
  readonly job: string;
  readonly needs?: readonly string[] | undefined;
}

export interface GraphMetrics {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly columnGap: number;
  readonly rowGap: number;
}

export interface GraphNode<Job extends GraphJob> {
  readonly job: Job;
  readonly column: number;
  readonly x: number;
  readonly y: number;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly path: string;
}

export interface GraphLayout<Job extends GraphJob> {
  readonly nodes: readonly GraphNode<Job>[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
}

export function jobLevels(jobs: readonly GraphJob[]): Map<string, number> {
  const byName = new Map(jobs.map((job) => [job.job, job]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (name: string): number => {
    const known = levels.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return -1;
    visiting.add(name);
    let result = 0;
    for (const need of byName.get(name)?.needs ?? [])
      if (need !== name && byName.has(need)) result = Math.max(result, level(need) + 1);
    visiting.delete(name);
    levels.set(name, result);
    return result;
  };
  for (const job of jobs) level(job.job);
  return levels;
}

export function layoutJobGraph<Job extends GraphJob>(
  jobs: readonly Job[],
  metrics: GraphMetrics,
): GraphLayout<Job> {
  const levels = jobLevels(jobs);
  const columns: Job[][] = [];
  for (const job of jobs) (columns[levels.get(job.job) ?? 0] ??= []).push(job);
  const nodes: GraphNode<Job>[] = [];
  const positions = new Map<string, GraphNode<Job>>();
  columns.forEach((column, index) =>
    column.forEach((job, row) => {
      const node = {
        job,
        column: index,
        x: index * (metrics.nodeWidth + metrics.columnGap),
        y: row * (metrics.nodeHeight + metrics.rowGap),
      };
      nodes.push(node);
      positions.set(job.job, node);
    }),
  );
  const edges: GraphEdge[] = [];
  for (const node of nodes)
    for (const need of new Set(node.job.needs ?? [])) {
      const source = positions.get(need);
      if (!source || source.column >= node.column) continue;
      const x1 = source.x + metrics.nodeWidth;
      const y1 = source.y + metrics.nodeHeight / 2;
      const x2 = node.x;
      const y2 = node.y + metrics.nodeHeight / 2;
      const bend = Math.min(metrics.columnGap / 2, (x2 - x1) / 2);
      edges.push({
        from: need,
        to: node.job.job,
        path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      });
    }
  const rows = Math.max(0, ...columns.map((column) => column.length));
  return {
    nodes,
    edges,
    width: Math.max(
      0,
      columns.length * (metrics.nodeWidth + metrics.columnGap) - metrics.columnGap,
    ),
    height: Math.max(0, rows * (metrics.nodeHeight + metrics.rowGap) - metrics.rowGap),
  };
}
