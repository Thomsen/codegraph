export declare const WORKSPACE_PROTOCOL_VERSION = 1;
export declare const WORKSPACE_MANIFEST_PATH: string;
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
export declare class WorkspaceRootAmbiguityError extends Error {
    readonly candidates: string[];
    constructor(candidates: string[]);
}
export interface WorkspaceRootDiscoveryOptions {
    explicitRoot?: string | null;
    advertisedRoots?: string[];
    cwd?: string;
}
/** Resolve the root using explicit > unique advertised > upward cwd precedence. */
export declare function discoverCodeGraphRoot(options: WorkspaceRootDiscoveryOptions): string | null;
/** Atomically replace the rooted workspace manifest. */
export declare function writeWorkspaceManifest(root: string, manifest: WorkspaceManifest): void;
export declare function loadWorkspaceManifest(root: string): WorkspaceManifest;
export declare function createWorkspaceResolution(manifest: WorkspaceManifest): WorkspaceResolution;
//# sourceMappingURL=workspace.d.ts.map