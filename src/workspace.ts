import * as fs from 'fs';
import * as path from 'path';
import { findNearestCodeGraphRoot } from './directory';

export const WORKSPACE_PROTOCOL_VERSION = 1;
export const WORKSPACE_MANIFEST_PATH = path.join('.codegraph', 'workspace.json');

export interface WorkspaceMember {
  name: string;
  path: string;
}

export interface WorkspaceManifest {
  version: 1;
  workset: string;
  members: WorkspaceMember[];
}

export interface WorkspaceResolution {
  resolveFilePath(filePath: string): string | null;
  workspacePackages: {
    byName: Map<string, string>;
    entryByName?: Map<string, string>;
  };
}

export class WorkspaceRootAmbiguityError extends Error {
  constructor(readonly candidates: string[]) {
    super(`Ambiguous CodeGraph workspace roots: ${candidates.join(', ')}`);
    this.name = 'WorkspaceRootAmbiguityError';
  }
}

export interface WorkspaceRootDiscoveryOptions {
  explicitRoot?: string | null;
  advertisedRoots?: string[];
  cwd?: string;
}

/** Resolve the root using explicit > unique advertised > upward cwd precedence. */
export function discoverCodeGraphRoot(options: WorkspaceRootDiscoveryOptions): string | null {
  const findCanonicalRoot = (candidate: string): string | null => {
    const root = findNearestCodeGraphRoot(path.resolve(candidate));
    return root ? fs.realpathSync(root) : null;
  };
  if (options.explicitRoot) {
    return findCanonicalRoot(options.explicitRoot);
  }

  const advertised = new Set<string>();
  for (const candidate of options.advertisedRoots ?? []) {
    const root = findCanonicalRoot(candidate);
    if (root) advertised.add(root);
  }
  if (advertised.size > 1) throw new WorkspaceRootAmbiguityError([...advertised].sort());
  if (advertised.size === 1) return [...advertised][0]!;
  return findCanonicalRoot(options.cwd ?? process.cwd());
}

/** Atomically replace the rooted workspace manifest. */
export function writeWorkspaceManifest(root: string, manifest: WorkspaceManifest): void {
  const manifestPath = path.join(path.resolve(root), WORKSPACE_MANIFEST_PATH);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    fs.renameSync(temporaryPath, manifestPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch { /* rename succeeded, or no temporary file was created */ }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid CodeGraph workspace manifest: ${field} must be a non-empty string`);
  }
  return value;
}

export function loadWorkspaceManifest(root: string): WorkspaceManifest {
  const manifestPath = path.join(path.resolve(root), WORKSPACE_MANIFEST_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Could not read CodeGraph workspace manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid CodeGraph workspace manifest: expected an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== WORKSPACE_PROTOCOL_VERSION) {
    throw new Error(`Unsupported CodeGraph workspace protocol version: ${String(record.version)}`);
  }
  if (!Array.isArray(record.members) || record.members.length === 0) {
    throw new Error('Invalid CodeGraph workspace manifest: members must be a non-empty array');
  }

  const names = new Set<string>();
  const paths = new Set<string>();
  const members = record.members.map((value, index): WorkspaceMember => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid CodeGraph workspace manifest: members[${index}] must be an object`);
    }
    const member = value as Record<string, unknown>;
    const name = requireString(member.name, `members[${index}].name`);
    if (name === '.' || name === '..' || /[\\/]/u.test(name)) {
      throw new Error(`Invalid CodeGraph workspace member name: ${name}`);
    }
    const inputPath = requireString(member.path, `members[${index}].path`);
    const canonicalPath = fs.realpathSync(path.resolve(inputPath));
    if (!fs.statSync(canonicalPath).isDirectory()) {
      throw new Error(`CodeGraph workspace member is not a directory: ${inputPath}`);
    }
    if (names.has(name)) throw new Error(`Duplicate CodeGraph workspace member name: ${name}`);
    if (paths.has(canonicalPath)) throw new Error(`Duplicate CodeGraph workspace member path: ${canonicalPath}`);
    names.add(name);
    paths.add(canonicalPath);
    return { name, path: canonicalPath };
  });

  return {
    version: WORKSPACE_PROTOCOL_VERSION,
    workset: requireString(record.workset, 'workset'),
    members,
  };
}

export function createWorkspaceResolution(manifest: WorkspaceManifest): WorkspaceResolution {
  const members = new Map(manifest.members.map((member) => [member.name, member.path]));
  const byName = new Map<string, string>();
  const entryByName = new Map<string, string>();

  for (const member of manifest.members) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(member.path, 'package.json'), 'utf-8')) as {
        name?: unknown;
        main?: unknown;
      };
      if (typeof pkg.name === 'string' && pkg.name.length > 0 && !byName.has(pkg.name)) {
        byName.set(pkg.name, member.name);
        if (typeof pkg.main === 'string' && pkg.main.length > 0) {
          entryByName.set(pkg.name, `${member.name}/${pkg.main.replace(/^\.\//u, '')}`);
        }
      }
    } catch {
      // A member without a package.json simply has no package-name alias.
    }
  }

  return {
    resolveFilePath(filePath: string): string | null {
      const normalized = filePath.replace(/\\/gu, '/');
      const separator = normalized.indexOf('/');
      const memberName = separator < 0 ? normalized : normalized.slice(0, separator);
      const memberRoot = members.get(memberName);
      if (!memberRoot) return null;
      const relativePath = separator < 0 ? '' : normalized.slice(separator + 1);
      const resolved = path.resolve(memberRoot, relativePath);
      const relativeToMember = path.relative(memberRoot, resolved);
      if (relativeToMember === '..' || relativeToMember.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToMember)) {
        return null;
      }
      return resolved;
    },
    workspacePackages: {
      byName,
      ...(entryByName.size > 0 ? { entryByName } : {}),
    },
  };
}
