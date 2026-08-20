"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceRootAmbiguityError = exports.WORKSPACE_MANIFEST_PATH = exports.WORKSPACE_MANIFEST_VERSION = exports.WORKSPACE_PROTOCOL_VERSION = void 0;
exports.discoverCodeGraphRoot = discoverCodeGraphRoot;
exports.writeWorkspaceManifest = writeWorkspaceManifest;
exports.loadWorkspaceManifest = loadWorkspaceManifest;
exports.createWorkspaceResolution = createWorkspaceResolution;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const directory_1 = require("./directory");
exports.WORKSPACE_PROTOCOL_VERSION = 2;
exports.WORKSPACE_MANIFEST_VERSION = 1;
exports.WORKSPACE_MANIFEST_PATH = path.join('.codegraph', 'workspace.json');
class WorkspaceRootAmbiguityError extends Error {
    candidates;
    constructor(candidates) {
        super(`Ambiguous CodeGraph workspace roots: ${candidates.join(', ')}`);
        this.candidates = candidates;
        this.name = 'WorkspaceRootAmbiguityError';
    }
}
exports.WorkspaceRootAmbiguityError = WorkspaceRootAmbiguityError;
/** Resolve the root using explicit > unique advertised > upward cwd precedence. */
function discoverCodeGraphRoot(options) {
    const findCanonicalRoot = (candidate) => {
        const root = (0, directory_1.findNearestCodeGraphRoot)(path.resolve(candidate));
        return root ? fs.realpathSync(root) : null;
    };
    if (options.explicitRoot) {
        return findCanonicalRoot(options.explicitRoot);
    }
    const advertised = new Set();
    for (const candidate of options.advertisedRoots ?? []) {
        const root = findCanonicalRoot(candidate);
        if (root)
            advertised.add(root);
    }
    if (advertised.size > 1)
        throw new WorkspaceRootAmbiguityError([...advertised].sort());
    if (advertised.size === 1)
        return [...advertised][0];
    return findCanonicalRoot(options.cwd ?? process.cwd());
}
/** Atomically replace the rooted workspace manifest. */
function writeWorkspaceManifest(root, manifest) {
    const manifestPath = path.join(path.resolve(root), exports.WORKSPACE_MANIFEST_PATH);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const temporaryPath = `${manifestPath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
        fs.renameSync(temporaryPath, manifestPath);
    }
    finally {
        try {
            fs.unlinkSync(temporaryPath);
        }
        catch { /* rename succeeded, or no temporary file was created */ }
    }
}
function requireString(value, field) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Invalid CodeGraph workspace manifest: ${field} must be a non-empty string`);
    }
    return value;
}
function loadWorkspaceManifest(root) {
    const manifestPath = path.join(path.resolve(root), exports.WORKSPACE_MANIFEST_PATH);
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }
    catch (error) {
        throw new Error(`Could not read CodeGraph workspace manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid CodeGraph workspace manifest: expected an object');
    }
    const record = parsed;
    if (record.version !== exports.WORKSPACE_MANIFEST_VERSION) {
        throw new Error(`Unsupported CodeGraph workspace manifest version: ${String(record.version)}`);
    }
    if (!Array.isArray(record.members) || record.members.length === 0) {
        throw new Error('Invalid CodeGraph workspace manifest: members must be a non-empty array');
    }
    const names = new Set();
    const paths = new Set();
    const members = record.members.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`Invalid CodeGraph workspace manifest: members[${index}] must be an object`);
        }
        const member = value;
        const name = requireString(member.name, `members[${index}].name`);
        if (name === '.' || name === '..' || /[\\/]/u.test(name)) {
            throw new Error(`Invalid CodeGraph workspace member name: ${name}`);
        }
        const inputPath = requireString(member.path, `members[${index}].path`);
        const canonicalPath = fs.realpathSync(path.resolve(inputPath));
        if (!fs.statSync(canonicalPath).isDirectory()) {
            throw new Error(`CodeGraph workspace member is not a directory: ${inputPath}`);
        }
        if (names.has(name))
            throw new Error(`Duplicate CodeGraph workspace member name: ${name}`);
        if (paths.has(canonicalPath))
            throw new Error(`Duplicate CodeGraph workspace member path: ${canonicalPath}`);
        names.add(name);
        paths.add(canonicalPath);
        return { name, path: canonicalPath };
    });
    return {
        version: exports.WORKSPACE_MANIFEST_VERSION,
        workset: requireString(record.workset, 'workset'),
        members,
    };
}
function createWorkspaceResolution(manifest) {
    const members = new Map(manifest.members.map((member) => [member.name, member.path]));
    const byName = new Map();
    const entryByName = new Map();
    for (const member of manifest.members) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(member.path, 'package.json'), 'utf-8'));
            if (typeof pkg.name === 'string' && pkg.name.length > 0 && !byName.has(pkg.name)) {
                byName.set(pkg.name, member.name);
                if (typeof pkg.main === 'string' && pkg.main.length > 0) {
                    entryByName.set(pkg.name, `${member.name}/${pkg.main.replace(/^\.\//u, '')}`);
                }
            }
        }
        catch {
            // A member without a package.json simply has no package-name alias.
        }
    }
    return {
        resolveFilePath(filePath) {
            const normalized = filePath.replace(/\\/gu, '/');
            const separator = normalized.indexOf('/');
            const memberName = separator < 0 ? normalized : normalized.slice(0, separator);
            const memberRoot = members.get(memberName);
            if (!memberRoot)
                return null;
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
//# sourceMappingURL=workspace.js.map