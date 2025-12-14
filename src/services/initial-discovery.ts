/**
 * Initial Discovery Service
 *
 * Creates entities with text files during batch finalization.
 * Returns root_pi immediately to clients.
 *
 * Uses operation-based batching to avoid subrequest limits:
 * - UPLOADING phase: Upload N files per alarm
 * - PUBLISHING phase: Create N entities per alarm
 * - RELATIONSHIPS phase: Attach to parent
 */

import type {
  Env,
  BatchManifest,
  DiscoveryState,
  DiscoveryNode,
  DiscoveryResult,
  DiscoveryTextFile,
} from '../types';
import { IPFSWrapperClient } from './ipfs-wrapper';

// Text file extensions to upload to IPFS during initial discovery
const TEXT_EXTENSIONS = new Set([
  'md',
  'txt',
  'json',
  'xml',
  'csv',
  'html',
  'htm',
]);

// Batching configuration
// Constraint: Cloudflare Workers allow 1000 subrequests per invocation (paid plan)
const UPLOAD_BATCH_SIZE = 100; // Files to upload per alarm iteration
const ENTITY_BATCH_SIZE = 100; // Entities to create per alarm iteration

/**
 * Check if a file is a text file based on extension
 */
function isTextFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Build discovery tree from manifest (synchronous, no I/O)
 *
 * Creates DiscoveryNode for each directory and classifies files.
 * Text files are marked for upload, binary files are skipped (handled by preprocessor).
 */
export function buildDiscoveryTree(manifest: BatchManifest): DiscoveryState {
  const nodes: Record<string, DiscoveryNode> = {};
  const allPaths = new Set<string>();
  let totalFiles = 0;

  // Create nodes for each directory in manifest
  for (const dirGroup of manifest.directories) {
    const dirPath = dirGroup.directory_path;
    allPaths.add(dirPath);

    const depth = dirPath === '/' ? 0 : dirPath.split('/').filter((p) => p).length;

    nodes[dirPath] = {
      path: dirPath,
      depth,
      children_paths: [],
      text_files: [],
      published: false,
    };

    // Classify text files for this directory
    for (const file of dirGroup.files) {
      if (isTextFile(file.file_name)) {
        nodes[dirPath].text_files.push({
          filename: file.file_name,
          r2_key: file.r2_key,
          // cid will be set after upload
        });
        totalFiles++;
      }
      // Binary files are skipped - handled by preprocessor
    }
  }

  // Build parent-child relationships from paths
  for (const dirPath of allPaths) {
    if (dirPath === '/') continue;

    const parts = dirPath.split('/').filter((p) => p);
    const parentPath = parts.length === 1 ? '/' : '/' + parts.slice(0, -1).join('/');

    const node = nodes[dirPath];
    if (node) {
      node.parent_path = parentPath;
    }

    // Ensure parent exists (may not be in manifest if it has no files)
    if (!nodes[parentPath]) {
      const parentDepth = parentPath === '/' ? 0 : parentPath.split('/').filter((p) => p).length;
      nodes[parentPath] = {
        path: parentPath,
        depth: parentDepth,
        children_paths: [],
        text_files: [],
        published: false,
      };
      allPaths.add(parentPath);
    }

    // Add this directory as child of parent
    if (!nodes[parentPath].children_paths.includes(dirPath)) {
      nodes[parentPath].children_paths.push(dirPath);
    }
  }

  // Ensure root exists
  if (!nodes['/']) {
    nodes['/'] = {
      path: '/',
      depth: 0,
      children_paths: Array.from(allPaths).filter((p) => {
        if (p === '/') return false;
        const parts = p.split('/').filter((s) => s);
        return parts.length === 1; // Direct children of root
      }),
      text_files: [],
      published: false,
    };
  }

  // Calculate max depth for bottom-up processing
  const maxDepth = Math.max(...Object.values(nodes).map((n) => n.depth));

  return {
    nodes,
    directories_total: Object.keys(nodes).length,
    directories_published: 0,
    node_pis: {},
    node_tips: {},
    node_versions: {},
    phase: totalFiles > 0 ? 'UPLOADING' : 'PUBLISHING', // Skip upload phase if no text files
    current_depth: maxDepth, // Start from deepest (bottom-up)
    files_total: totalFiles,
    files_uploaded: 0,
  };
}

/**
 * Get all files that need uploading (CID not yet set)
 * Note: Empty string CID means upload failed, don't retry
 */
function getFilesNeedingUpload(state: DiscoveryState): Array<{ node: DiscoveryNode; file: DiscoveryTextFile }> {
  const files: Array<{ node: DiscoveryNode; file: DiscoveryTextFile }> = [];

  for (const node of Object.values(state.nodes)) {
    for (const file of node.text_files) {
      // Only retry if CID is undefined (not yet attempted)
      // Empty string means failed - don't retry
      if (file.cid === undefined) {
        files.push({ node, file });
      }
    }
  }

  return files;
}

/**
 * Upload a batch of files to IPFS
 * Returns true if more files need uploading
 */
export async function uploadFileBatch(
  state: DiscoveryState,
  env: Env,
  batchSize: number = UPLOAD_BATCH_SIZE
): Promise<boolean> {
  const ipfsClient = new IPFSWrapperClient(env.ARKE_IPFS_API);

  // Get files that need uploading
  const pendingFiles = getFilesNeedingUpload(state).slice(0, batchSize);

  if (pendingFiles.length === 0) {
    // All files uploaded, move to publishing phase
    state.phase = 'PUBLISHING';
    console.log(`[Discovery] All ${state.files_uploaded} files uploaded, moving to PUBLISHING phase`);
    return true; // More work in next phase
  }

  console.log(`[Discovery] Uploading ${pendingFiles.length} files (${state.files_uploaded}/${state.files_total} done)`);

  // Upload files in parallel (within batch)
  await Promise.all(
    pendingFiles.map(async ({ node, file }) => {
      try {
        const obj = await env.STAGING_BUCKET.get(file.r2_key);
        if (obj) {
          const content = await obj.text();
          const cid = await ipfsClient.uploadContent(content, file.filename);
          file.cid = cid;
          state.files_uploaded++;
          console.log(`[Discovery] Uploaded ${node.path}/${file.filename} -> ${cid}`);
        }
      } catch (error) {
        console.error(`[Discovery] Failed to upload ${file.filename}:`, error);
        // Mark as uploaded with empty CID to skip it
        file.cid = '';
        state.files_uploaded++;
      }
    })
  );

  // Check if more files remain
  const remaining = getFilesNeedingUpload(state);
  if (remaining.length === 0) {
    state.phase = 'PUBLISHING';
    console.log(`[Discovery] All ${state.files_uploaded} files uploaded, moving to PUBLISHING phase`);
  }

  return true; // More work remains
}

/**
 * Check if all children of a node are published
 */
function allChildrenPublished(node: DiscoveryNode, state: DiscoveryState): boolean {
  return node.children_paths.every((childPath) => {
    const child = state.nodes[childPath];
    return child && child.published;
  });
}

/**
 * Get directories ready to publish at current depth
 * A directory is ready when all its children are published (bottom-up)
 */
function getDirectoriesReadyToPublish(state: DiscoveryState): DiscoveryNode[] {
  return Object.values(state.nodes)
    .filter((n) =>
      n.depth === state.current_depth &&
      !n.published &&
      allChildrenPublished(n, state)
    );
}

/**
 * Publish a single directory entity
 */
async function publishDirectory(
  node: DiscoveryNode,
  state: DiscoveryState,
  ipfsClient: IPFSWrapperClient
): Promise<void> {
  // Build components from uploaded files
  const components: Record<string, string> = {};
  for (const file of node.text_files) {
    if (file.cid && file.cid.length > 0) {
      components[file.filename] = file.cid;
    }
  }

  // Get child PIs (children are processed first due to bottom-up order)
  const childPis: string[] = node.children_paths
    .map((path) => state.node_pis[path])
    .filter((pi): pi is string => !!pi);

  // Create entity (v1 with text files and child relationships)
  const result = await ipfsClient.createEntity({
    type: 'PI',
    components,
    children_pi: childPis,
    note: 'Initial discovery snapshot',
  });

  // Update node and state tracking
  node.pi = result.pi;
  node.tip = result.tip;
  node.version = result.ver;
  node.published = true;

  state.node_pis[node.path] = result.pi;
  state.node_tips[node.path] = result.tip;
  state.node_versions[node.path] = result.ver;
  state.directories_published++;

  console.log(
    `[Discovery] Published ${node.path}: PI=${result.pi}, ${Object.keys(components).length} components, ${childPis.length} children`
  );
}

/**
 * Publish a batch of directories
 * Returns true if more work remains
 */
export async function publishDirectoryBatch(
  state: DiscoveryState,
  env: Env,
  batchSize: number = ENTITY_BATCH_SIZE
): Promise<boolean> {
  const ipfsClient = new IPFSWrapperClient(env.ARKE_IPFS_API);

  // Get directories ready to publish at current depth
  const readyDirs = getDirectoriesReadyToPublish(state).slice(0, batchSize);

  if (readyDirs.length === 0) {
    // No directories ready at current depth, move up
    if (state.current_depth > 0) {
      state.current_depth--;
      console.log(`[Discovery] Moving to depth ${state.current_depth}`);
      return true; // More work at shallower depth
    } else {
      // All depths processed, move to relationships phase
      state.phase = 'RELATIONSHIPS';
      console.log('[Discovery] All directories published, moving to RELATIONSHIPS phase');
      return true;
    }
  }

  console.log(
    `[Discovery] Publishing ${readyDirs.length} directories at depth ${state.current_depth} (${state.directories_published}/${state.directories_total} done)`
  );

  // Publish directories in parallel (within batch)
  await Promise.all(
    readyDirs.map((node) => publishDirectory(node, state, ipfsClient))
  );

  // Check if more directories remain at any depth
  const unpublishedCount = Object.values(state.nodes).filter((n) => !n.published).length;
  return unpublishedCount > 0 || state.phase !== 'DONE';
}

/**
 * Process one batch of work based on current phase
 * Returns true if more work remains
 */
export async function processDiscoveryBatch(
  state: DiscoveryState,
  env: Env,
  uploadBatchSize: number = UPLOAD_BATCH_SIZE,
  entityBatchSize: number = ENTITY_BATCH_SIZE
): Promise<boolean> {
  switch (state.phase) {
    case 'UPLOADING':
      return uploadFileBatch(state, env, uploadBatchSize);

    case 'PUBLISHING':
      return publishDirectoryBatch(state, env, entityBatchSize);

    case 'RELATIONSHIPS':
      return establishRelationshipsBatch(state, env, entityBatchSize);

    case 'DONE':
    case 'ERROR':
      return false;

    default:
      console.error(`[Discovery] Unknown phase: ${state.phase}`);
      return false;
  }
}

/**
 * Get parents that need relationship setup (have children, published, not yet processed)
 */
function getParentsNeedingRelationships(state: DiscoveryState): DiscoveryNode[] {
  return Object.values(state.nodes).filter(
    (node) =>
      node.children_paths.length > 0 &&
      node.pi &&
      node.published &&
      !node.relationships_set
  );
}

/**
 * Set parent_pi on children for a single parent node
 */
async function setParentPiOnChildren(
  parentNode: DiscoveryNode,
  state: DiscoveryState,
  ipfsClient: IPFSWrapperClient
): Promise<void> {
  const childPis = parentNode.children_paths
    .map((path) => state.node_pis[path])
    .filter((pi): pi is string => !!pi);

  if (childPis.length === 0) {
    parentNode.relationships_set = true;
    return;
  }

  // updateRelations will set parent_pi on all children
  // The children are already in the parent's children_pi array,
  // but this call triggers the reverse link setup
  await ipfsClient.updateRelations({
    parent_pi: parentNode.pi!,
    add_children: childPis,
    note: 'Set parent_pi on children',
  });

  parentNode.relationships_set = true;
  console.log(
    `[Discovery] Set parent_pi on ${childPis.length} children of ${parentNode.path} (${parentNode.pi})`
  );
}

/**
 * Establish parent-child relationships in batches (bidirectional)
 * Processes N parents per batch in parallel.
 * Returns true if more work remains.
 */
export async function establishRelationshipsBatch(
  state: DiscoveryState,
  env: Env,
  batchSize: number = ENTITY_BATCH_SIZE
): Promise<boolean> {
  const ipfsClient = new IPFSWrapperClient(env.ARKE_IPFS_API);

  // Get parents that need relationship setup
  const pendingParents = getParentsNeedingRelationships(state).slice(0, batchSize);

  if (pendingParents.length === 0) {
    // All internal relationships done, move to DONE phase
    state.phase = 'DONE';
    console.log('[Discovery] All relationships established, phase complete');
    return false;
  }

  const totalPending = getParentsNeedingRelationships(state).length;
  console.log(
    `[Discovery] Setting parent_pi for ${pendingParents.length} parents (${totalPending} remaining)`
  );

  // Process parents in parallel (within batch)
  await Promise.all(
    pendingParents.map(async (parentNode) => {
      try {
        await setParentPiOnChildren(parentNode, state, ipfsClient);
      } catch (error) {
        console.error(
          `[Discovery] Failed to set parent_pi for children of ${parentNode.path}:`,
          error
        );
        // Mark as done to avoid infinite retry - log the error
        parentNode.relationships_set = true;
      }
    })
  );

  // Check if more parents remain
  const remaining = getParentsNeedingRelationships(state).length;
  return remaining > 0;
}

/**
 * Attach root to external parent (called after all internal relationships are set)
 */
export async function attachToExternalParent(
  state: DiscoveryState,
  env: Env,
  parentPi: string
): Promise<void> {
  const ipfsClient = new IPFSWrapperClient(env.ARKE_IPFS_API);

  if (state.node_pis['/']) {
    try {
      await ipfsClient.addChildToParent({
        parent_pi: parentPi,
        child_pi: state.node_pis['/'],
      });
      console.log(`[Discovery] Attached root ${state.node_pis['/']} to parent ${parentPi}`);
    } catch (error) {
      console.error(`[Discovery] Failed to attach root to parent ${parentPi}:`, error);
      // Don't fail discovery for this - root entity still exists
    }
  }
}

/**
 * Establish all relationships synchronously (for sync discovery)
 * Processes all parents in parallel batches.
 */
async function establishAllRelationships(
  state: DiscoveryState,
  env: Env,
  parentPi?: string
): Promise<void> {
  // Process internal relationships in large batches
  while (state.phase === 'RELATIONSHIPS') {
    const hasMore = await establishRelationshipsBatch(state, env, 1000);
    if (!hasMore) break;
  }

  // Attach to external parent if specified
  if (parentPi) {
    await attachToExternalParent(state, env, parentPi);
  }
}

/**
 * Run complete discovery synchronously (for small batches)
 *
 * Use this when batch has < SYNC_DISCOVERY_MAX_DIRS directories
 * AND < SYNC_DISCOVERY_MAX_FILES total text files.
 * Returns discovery result with root_pi immediately.
 */
export async function runSyncDiscovery(
  manifest: BatchManifest,
  env: Env,
  parentPi?: string
): Promise<DiscoveryResult> {
  console.log(`[Discovery] Running sync discovery for ${manifest.directories.length} directories`);

  // Build tree
  const state = buildDiscoveryTree(manifest);
  console.log(
    `[Discovery] Built tree with ${state.directories_total} nodes, ${state.files_total} files, max depth ${state.current_depth}`
  );

  // Upload all files (large batch for sync)
  while (state.phase === 'UPLOADING') {
    await uploadFileBatch(state, env, 1000);
  }

  // Publish all directories (large batch for sync)
  while (state.phase === 'PUBLISHING') {
    await publishDirectoryBatch(state, env, 1000);
  }

  // Establish bidirectional relationships (set parent_pi on children, attach to external parent)
  await establishAllRelationships(state, env, parentPi);

  const rootPi = state.node_pis['/'];
  if (!rootPi) {
    throw new Error('Discovery completed but root PI not found');
  }

  console.log(`[Discovery] Sync discovery complete, root_pi: ${rootPi}`);

  return {
    root_pi: rootPi,
    node_pis: state.node_pis,
    node_tips: state.node_tips,
    node_versions: state.node_versions,
  };
}
