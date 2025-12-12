/**
 * Verify parent-child bidirectional relationships after ingest
 *
 * Usage:
 *   npx ts-node tests/verify-relationships.ts <batch_id>
 *   npx ts-node tests/verify-relationships.ts --pi <root_pi>
 *
 * Environment variables:
 *   INGEST_URL - Ingest worker URL (default: https://ingest.arke.institute)
 *   API_URL - IPFS API URL (default: https://api.arke.institute)
 */

const INGEST_URL = process.env.INGEST_URL || 'https://ingest.arke.institute';
const API_URL = process.env.API_URL || 'https://api.arke.institute';

interface Entity {
  pi: string;
  ver: number;
  components: Record<string, string>;
  children_pi?: string[];
  parent_pi?: string;
  note?: string;
}

interface BatchStatus {
  batch_id: string;
  status: string;
  root_pi?: string;
  discovery_state?: {
    node_pis: Record<string, string>;
    node_tips: Record<string, string>;
    node_versions: Record<string, number>;
  };
}

interface RelationshipError {
  pi: string;
  path?: string;
  issue: string;
  expected?: string;
  actual?: string;
}

async function fetchEntity(pi: string): Promise<Entity | null> {
  try {
    const response = await fetch(`${API_URL}/entities/${pi}`);
    if (!response.ok) {
      console.error(`Failed to fetch entity ${pi}: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching entity ${pi}:`, error);
    return null;
  }
}

async function fetchBatchStatus(batchId: string): Promise<BatchStatus | null> {
  try {
    const response = await fetch(`${INGEST_URL}/api/batches/${batchId}/status`);
    if (!response.ok) {
      console.error(`Failed to fetch batch status: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching batch status:`, error);
    return null;
  }
}

async function verifyRelationships(
  nodePis: Record<string, string>
): Promise<{ errors: RelationshipError[]; verified: number }> {
  const errors: RelationshipError[] = [];
  let verified = 0;

  // Build path -> PI and PI -> path maps
  const pathToPi = nodePis;
  const piToPath: Record<string, string> = {};
  for (const [path, pi] of Object.entries(nodePis)) {
    piToPath[pi] = path;
  }

  // Build expected parent relationships from paths
  const expectedParent: Record<string, string | null> = {};
  for (const path of Object.keys(nodePis)) {
    if (path === '/') {
      expectedParent[path] = null; // Root has no parent
    } else {
      const parts = path.split('/').filter((p) => p);
      const parentPath = parts.length === 1 ? '/' : '/' + parts.slice(0, -1).join('/');
      expectedParent[path] = parentPath;
    }
  }

  console.log('\n=== Verifying Parent-Child Relationships ===\n');
  console.log('Expected structure:');
  for (const [path, parentPath] of Object.entries(expectedParent)) {
    const pi = pathToPi[path];
    const parentPi = parentPath ? pathToPi[parentPath] : 'none';
    console.log(`  ${path} (${pi?.slice(0, 12)}...) -> parent: ${parentPath || 'none'} (${parentPi?.slice(0, 12) || 'N/A'}...)`);
  }
  console.log('');

  // Verify each entity
  for (const [path, pi] of Object.entries(nodePis)) {
    console.log(`Checking ${path} (${pi})...`);

    const entity = await fetchEntity(pi);
    if (!entity) {
      errors.push({ pi, path, issue: 'Entity not found' });
      continue;
    }

    const expectedParentPath = expectedParent[path];

    // Check parent_pi
    if (expectedParentPath === null) {
      // Root entity - should have no parent_pi (or could have external parent)
      console.log(`  Root entity - parent_pi: ${entity.parent_pi || 'none'} (OK - root can have external parent or none)`);
    } else {
      const expectedParentPi = pathToPi[expectedParentPath];

      if (!entity.parent_pi) {
        errors.push({
          pi,
          path,
          issue: 'Missing parent_pi',
          expected: expectedParentPi,
          actual: 'undefined',
        });
        console.log(`  ERROR: parent_pi not set! Expected: ${expectedParentPi}`);
      } else if (entity.parent_pi !== expectedParentPi) {
        errors.push({
          pi,
          path,
          issue: 'Wrong parent_pi',
          expected: expectedParentPi,
          actual: entity.parent_pi,
        });
        console.log(`  ERROR: Wrong parent_pi! Expected: ${expectedParentPi}, Got: ${entity.parent_pi}`);
      } else {
        console.log(`  parent_pi: ${entity.parent_pi} (correct)`);
        verified++;
      }
    }

    // Check children_pi
    const expectedChildPaths = Object.keys(nodePis).filter((p) => {
      if (p === path) return false;
      const parts = p.split('/').filter((s) => s);
      const parentPath = parts.length === 1 ? '/' : '/' + parts.slice(0, -1).join('/');
      return parentPath === path;
    });
    const expectedChildPis = expectedChildPaths.map((p) => pathToPi[p]).sort();
    const actualChildPis = (entity.children_pi || []).sort();

    if (expectedChildPis.length > 0 || actualChildPis.length > 0) {
      const missingChildren = expectedChildPis.filter((pi) => !actualChildPis.includes(pi));
      const extraChildren = actualChildPis.filter((pi) => !expectedChildPis.includes(pi));

      if (missingChildren.length > 0) {
        errors.push({
          pi,
          path,
          issue: 'Missing children in children_pi',
          expected: missingChildren.join(', '),
          actual: 'not present',
        });
        console.log(`  ERROR: Missing children: ${missingChildren.join(', ')}`);
      }

      if (extraChildren.length > 0) {
        // Extra children might be OK (external additions), just note it
        console.log(`  Note: Extra children not in discovery: ${extraChildren.join(', ')}`);
      }

      if (missingChildren.length === 0) {
        console.log(`  children_pi: ${actualChildPis.length} children (correct)`);
      }
    }

    console.log('');
  }

  return { errors, verified };
}

async function verifyFromRootPi(rootPi: string): Promise<void> {
  console.log(`\n=== Traversing from Root PI: ${rootPi} ===\n`);

  const visited = new Set<string>();
  const queue: Array<{ pi: string; depth: number; parentPi?: string }> = [{ pi: rootPi, depth: 0 }];
  const errors: RelationshipError[] = [];

  while (queue.length > 0) {
    const { pi, depth, parentPi } = queue.shift()!;

    if (visited.has(pi)) continue;
    visited.add(pi);

    const indent = '  '.repeat(depth);
    console.log(`${indent}Fetching ${pi}...`);

    const entity = await fetchEntity(pi);
    if (!entity) {
      errors.push({ pi, issue: 'Entity not found' });
      continue;
    }

    // Check parent_pi matches expected
    if (parentPi !== undefined) {
      if (entity.parent_pi !== parentPi) {
        errors.push({
          pi,
          issue: 'Wrong parent_pi',
          expected: parentPi,
          actual: entity.parent_pi || 'undefined',
        });
        console.log(`${indent}  ERROR: parent_pi mismatch! Expected: ${parentPi}, Got: ${entity.parent_pi}`);
      } else {
        console.log(`${indent}  parent_pi: ${entity.parent_pi} (correct)`);
      }
    } else {
      console.log(`${indent}  parent_pi: ${entity.parent_pi || 'none'} (root)`);
    }

    // Queue children
    if (entity.children_pi && entity.children_pi.length > 0) {
      console.log(`${indent}  children_pi: ${entity.children_pi.length} children`);
      for (const childPi of entity.children_pi) {
        queue.push({ pi: childPi, depth: depth + 1, parentPi: pi });
      }
    } else {
      console.log(`${indent}  children_pi: none (leaf)`);
    }
  }

  console.log(`\n=== Traversal Complete ===`);
  console.log(`Visited ${visited.size} entities`);

  if (errors.length > 0) {
    console.log(`\nERRORS FOUND: ${errors.length}`);
    for (const error of errors) {
      console.log(`  - ${error.pi}: ${error.issue}`);
      if (error.expected) console.log(`    Expected: ${error.expected}`);
      if (error.actual) console.log(`    Actual: ${error.actual}`);
    }
    process.exit(1);
  } else {
    console.log(`\nAll relationships verified correctly!`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  npx ts-node tests/verify-relationships.ts <batch_id>');
    console.log('  npx ts-node tests/verify-relationships.ts --pi <root_pi>');
    process.exit(1);
  }

  if (args[0] === '--pi') {
    if (!args[1]) {
      console.error('Missing root PI');
      process.exit(1);
    }
    await verifyFromRootPi(args[1]);
    return;
  }

  // Assume it's a batch ID
  const batchId = args[0];
  console.log(`Fetching batch status for ${batchId}...`);

  const status = await fetchBatchStatus(batchId);
  if (!status) {
    console.error('Failed to fetch batch status');
    process.exit(1);
  }

  console.log(`Batch status: ${status.status}`);

  if (!status.root_pi) {
    console.error('Batch has no root_pi - discovery may not be complete');
    process.exit(1);
  }

  console.log(`Root PI: ${status.root_pi}`);

  // Try to get node_pis from discovery_state
  const nodePis = status.discovery_state?.node_pis;

  if (nodePis && Object.keys(nodePis).length > 0) {
    console.log(`Found ${Object.keys(nodePis).length} nodes in discovery state`);
    const { errors, verified } = await verifyRelationships(nodePis);

    console.log('\n=== Summary ===');
    console.log(`Total nodes: ${Object.keys(nodePis).length}`);
    console.log(`Verified parent_pi links: ${verified}`);
    console.log(`Errors: ${errors.length}`);

    if (errors.length > 0) {
      console.log('\nErrors:');
      for (const error of errors) {
        console.log(`  ${error.path || error.pi}: ${error.issue}`);
        if (error.expected) console.log(`    Expected: ${error.expected}`);
        if (error.actual) console.log(`    Actual: ${error.actual}`);
      }
      process.exit(1);
    } else {
      console.log('\nAll relationships verified correctly!');
    }
  } else {
    // Fall back to traversal from root
    console.log('No node_pis in discovery state, traversing from root...');
    await verifyFromRootPi(status.root_pi);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
