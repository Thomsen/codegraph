import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CodeGraph, discoverCodeGraphRoot } from '../src';
import { __emitWatchEventForTests } from '../src/sync/watcher';
import { ToolHandler } from '../src/mcp/tools';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('multi-root workspace indexing', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('indexes same-named files from two members into one namespaced graph', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-workspace-'));
    tempDirs.push(tempDir);
    const root = path.join(tempDir, 'root');
    const memberA = path.join(tempDir, 'repo-a');
    const memberB = path.join(tempDir, 'repo-b');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.mkdirSync(memberA, { recursive: true });
    fs.mkdirSync(memberB, { recursive: true });
    fs.writeFileSync(path.join(memberA, 'index.ts'), 'export function fromA() { return "a"; }\n');
    fs.writeFileSync(path.join(memberB, 'index.ts'), 'export function fromB() { return "b"; }\n');
    fs.writeFileSync(
      path.join(root, '.codegraph', 'workspace.json'),
      JSON.stringify({
        version: 1,
        workset: 'demo',
        members: [
          { name: 'a', path: memberA },
          { name: 'b', path: memberB },
        ],
      })
    );
    const graph = await CodeGraph.initWorkspace(root);
    try {
      expect(fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))).toBe(true);
      expect(graph.getStats().fileCount).toBe(2);
      expect(graph.getFile('a/index.ts')).not.toBeNull();
      expect(graph.getFile('b/index.ts')).not.toBeNull();
      expect(graph.searchNodes('fromA').some(({ node }) => node.filePath === 'a/index.ts')).toBe(true);
      expect(graph.searchNodes('fromB').some(({ node }) => node.filePath === 'b/index.ts')).toBe(true);
    } finally {
      graph.close();
    }
  });

  it('initializes and reports a workspace through JSON CLI commands', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-workspace-cli-'));
    tempDirs.push(tempDir);
    const root = path.join(tempDir, 'root');
    const memberA = path.join(tempDir, 'repo-a');
    const memberB = path.join(tempDir, 'repo-b');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.mkdirSync(memberA, { recursive: true });
    fs.mkdirSync(memberB, { recursive: true });
    fs.writeFileSync(path.join(memberA, 'index.ts'), 'export function fromA() { return "a"; }\n');
    fs.writeFileSync(path.join(memberB, 'index.ts'), 'export function fromB() { return "b"; }\n');
    fs.writeFileSync(
      path.join(root, '.codegraph', 'workspace.json'),
      JSON.stringify({
        version: 1,
        workset: 'demo',
        members: [
          { name: 'a', path: memberA },
          { name: 'b', path: memberB },
        ],
      })
    );
    const canonicalRoot = fs.realpathSync(root);

    const run = (...args: string[]): Record<string, unknown> => {
      const stdout = execFileSync(process.execPath, [BIN, ...args], {
        cwd: root,
        encoding: 'utf-8',
        env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
      });
      return JSON.parse(stdout.trim());
    };

    expect(run('workspace', 'init', '--root', root, '--json')).toMatchObject({
      protocolVersion: 1,
      initialized: true,
      root: canonicalRoot,
      workset: 'demo',
      members: ['a', 'b'],
    });
    expect(run('workspace', 'status', '--root', root, '--json')).toMatchObject({
      protocolVersion: 1,
      initialized: true,
      root: canonicalRoot,
      workset: 'demo',
      members: ['a', 'b'],
      indexPath: path.join(canonicalRoot, '.codegraph', 'codegraph.db'),
    });
  });

  it('resolves package imports and impact across member boundaries', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-workspace-flow-'));
    tempDirs.push(tempDir);
    const root = path.join(tempDir, 'root');
    const consumer = path.join(tempDir, 'consumer');
    const provider = path.join(tempDir, 'provider');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.mkdirSync(consumer, { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(
      path.join(consumer, 'index.ts'),
      'import { provide } from "@demo/provider";\nexport function consume() { return provide(); }\n'
    );
    fs.writeFileSync(path.join(provider, 'package.json'), JSON.stringify({ name: '@demo/provider' }));
    fs.writeFileSync(path.join(provider, 'index.ts'), 'export function provide() { return "value"; }\n');
    fs.writeFileSync(
      path.join(root, '.codegraph', 'workspace.json'),
      JSON.stringify({
        version: 1,
        workset: 'flow',
        members: [
          { name: 'consumer', path: consumer },
          { name: 'provider', path: provider },
        ],
      })
    );

    const graph = await CodeGraph.initWorkspace(root);
    try {
      const provide = graph.searchNodes('provide').find(({ node }) => node.name === 'provide')!.node;
      expect(graph.getCallers(provide.id).map(({ node }) => node.name)).toContain('consume');
      expect([...graph.getImpactRadius(provide.id, 2).nodes.values()].map((node) => node.name)).toContain('consume');

      const mcp = new ToolHandler(graph);
      const search = await mcp.execute('codegraph_search', { query: 'provide' });
      const impact = await mcp.execute('codegraph_impact', { symbol: 'provide', depth: 2 });
      const explore = await mcp.execute('codegraph_explore', { query: 'consume provide' });
      expect(JSON.stringify(search)).toContain('provider/index.ts');
      expect(JSON.stringify(impact)).toContain('consume');
      expect(JSON.stringify(explore)).toContain('value');
    } finally {
      graph.close();
    }
  });

  it('syncs one changed member without removing the other member partition', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-workspace-sync-'));
    tempDirs.push(tempDir);
    const root = path.join(tempDir, 'root');
    const memberA = path.join(tempDir, 'repo-a');
    const memberB = path.join(tempDir, 'repo-b');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.mkdirSync(memberA, { recursive: true });
    fs.mkdirSync(memberB, { recursive: true });
    fs.writeFileSync(path.join(memberA, 'index.ts'), 'export function fromA() { return "a"; }\n');
    fs.writeFileSync(path.join(memberB, 'index.ts'), 'export function fromB() { return "b"; }\n');
    fs.writeFileSync(
      path.join(root, '.codegraph', 'workspace.json'),
      JSON.stringify({
        version: 1,
        workset: 'sync',
        members: [
          { name: 'a', path: memberA },
          { name: 'b', path: memberB },
        ],
      })
    );

    const graph = await CodeGraph.initWorkspace(root);
    try {
      fs.writeFileSync(path.join(memberA, 'index.ts'), 'export function changedA() { return "changed"; }\n');
      const result = await graph.syncWorkspace();

      expect(result.filesModified).toBe(1);
      expect(graph.getStats().fileCount).toBe(2);
      expect(graph.searchNodes('changedA').some(({ node }) => node.filePath === 'a/index.ts')).toBe(true);
      expect(graph.searchNodes('fromB').some(({ node }) => node.filePath === 'b/index.ts')).toBe(true);
    } finally {
      graph.close();
    }
  });

  it('watches every member root and syncs events into its partition', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-workspace-watch-'));
    tempDirs.push(tempDir);
    const root = path.join(tempDir, 'root');
    const memberA = path.join(tempDir, 'repo-a');
    const memberB = path.join(tempDir, 'repo-b');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.mkdirSync(memberA, { recursive: true });
    fs.mkdirSync(memberB, { recursive: true });
    fs.writeFileSync(path.join(memberA, 'index.ts'), 'export function fromA() { return "a"; }\n');
    fs.writeFileSync(path.join(memberB, 'index.ts'), 'export function fromB() { return "b"; }\n');
    fs.writeFileSync(
      path.join(root, '.codegraph', 'workspace.json'),
      JSON.stringify({
        version: 1,
        workset: 'watch',
        members: [
          { name: 'a', path: memberA },
          { name: 'b', path: memberB },
        ],
      })
    );

    const graph = await CodeGraph.initWorkspace(root);
    try {
      expect(graph.watchWorkspace({ debounceMs: 10, inertForTests: true })).toBe(true);
      fs.writeFileSync(path.join(memberB, 'index.ts'), 'export function watchedB() { return "changed"; }\n');
      expect(__emitWatchEventForTests(fs.realpathSync(memberB), 'index.ts')).toBe(true);
      await waitFor(() => graph.searchNodes('watchedB').some(({ node }) => node.filePath === 'b/index.ts'));
      await waitFor(() => graph.getPendingFiles().length === 0);

      expect(graph.searchNodes('fromA').some(({ node }) => node.filePath === 'a/index.ts')).toBe(true);
    } finally {
      graph.close();
    }
  });

  it('replaces a member partition and preserves the graph when validation fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-workspace-replace-'));
    tempDirs.push(tempDir);
    const root = path.join(tempDir, 'root');
    const memberA = path.join(tempDir, 'repo-a');
    const memberB = path.join(tempDir, 'repo-b');
    const replacementB = path.join(tempDir, 'repo-b-next');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.mkdirSync(memberA, { recursive: true });
    fs.mkdirSync(memberB, { recursive: true });
    fs.mkdirSync(replacementB, { recursive: true });
    fs.writeFileSync(path.join(memberA, 'index.ts'), 'export function fromA() { return "a"; }\n');
    fs.writeFileSync(path.join(memberB, 'index.ts'), 'export function oldB() { return "old"; }\n');
    fs.writeFileSync(path.join(replacementB, 'index.ts'), 'export function nextB() { return "next"; }\n');
    fs.writeFileSync(
      path.join(root, '.codegraph', 'workspace.json'),
      JSON.stringify({
        version: 1,
        workset: 'replace',
        members: [
          { name: 'a', path: memberA },
          { name: 'b', path: memberB },
        ],
      })
    );

    const graph = await CodeGraph.initWorkspace(root);
    try {
      await expect(graph.replaceWorkspaceMember('b', path.join(tempDir, 'missing'))).rejects.toThrow();
      expect(graph.searchNodes('oldB').some(({ node }) => node.filePath === 'b/index.ts')).toBe(true);

      await graph.replaceWorkspaceMember('b', replacementB);
      expect(graph.searchNodes('oldB')).toHaveLength(0);
      expect(graph.searchNodes('nextB').some(({ node }) => node.filePath === 'b/index.ts')).toBe(true);
      expect(graph.searchNodes('fromA').some(({ node }) => node.filePath === 'a/index.ts')).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'workspace.json'), 'utf-8')))
        .toMatchObject({ members: [{ name: 'a', path: fs.realpathSync(memberA) }, { name: 'b', path: fs.realpathSync(replacementB) }] });
    } finally {
      graph.close();
    }
  });

  it('discovers explicit, unique advertised, and cwd roots while rejecting ambiguity', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-workspace-discovery-'));
    tempDirs.push(tempDir);
    const rootA = path.join(tempDir, 'root-a');
    const rootB = path.join(tempDir, 'root-b');
    const nestedA = path.join(rootA, 'nested');
    fs.mkdirSync(nestedA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    const graphA = await CodeGraph.init(rootA);
    const graphB = await CodeGraph.init(rootB);
    graphA.close();
    graphB.close();

    expect(discoverCodeGraphRoot({ explicitRoot: nestedA, advertisedRoots: [rootB], cwd: rootB })).toBe(fs.realpathSync(rootA));
    expect(discoverCodeGraphRoot({ advertisedRoots: [nestedA, rootA], cwd: rootB })).toBe(fs.realpathSync(rootA));
    expect(discoverCodeGraphRoot({ cwd: nestedA })).toBe(fs.realpathSync(rootA));
    expect(() => discoverCodeGraphRoot({ advertisedRoots: [rootA, rootB], cwd: rootA })).toThrow(/Ambiguous/);
  });

  it('reopens a rooted workspace with physical source access from logical paths', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-workspace-reopen-'));
    tempDirs.push(tempDir);
    const root = path.join(tempDir, 'root');
    const member = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'index.ts'), 'export function reopenedSource() { return "physical"; }\n');
    fs.writeFileSync(
      path.join(root, '.codegraph', 'workspace.json'),
      JSON.stringify({ version: 1, workset: 'reopen', members: [{ name: 'repo', path: member }] })
    );
    const initialized = await CodeGraph.initWorkspace(root);
    initialized.close();

    const reopened = await CodeGraph.open(root);
    try {
      expect(reopened.isWorkspace()).toBe(true);
      expect(reopened.resolveFilePath('repo/index.ts')).toBe(path.join(fs.realpathSync(member), 'index.ts'));
      const context = await reopened.buildContext('reopenedSource', { includeCode: true, format: 'json' });
      expect(JSON.stringify(context)).toContain('physical');
    } finally {
      reopened.close();
    }
  });
});
