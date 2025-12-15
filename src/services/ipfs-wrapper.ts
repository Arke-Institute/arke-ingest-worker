/**
 * IPFS Wrapper Client for interacting with arke-ipfs-api service
 *
 * Copied from arke-orchestrator/src/services/ipfs-wrapper.ts with minor adaptations.
 * Uses Cloudflare service binding (Fetcher) for worker-to-worker communication.
 */

export interface CreateEntityRequest {
  type: string;                          // REQUIRED: Entity type (e.g., "PI", "Collection")
  components: Record<string, string>;
  children_pi: string[];
  parent_pi?: string;
  label?: string;                        // Optional: Display name
  description?: string;                  // Optional: Human-readable description
  note?: string;
}

export interface CreateEntityResponse {
  id: string;                            // Entity ID
  type: string;                          // Entity type
  ver: number;
  manifest_cid: string;
  tip: string;
}

export interface AppendVersionRequest {
  pi: string;
  components?: Record<string, string>;
  components_remove?: string[];
  children_pi_add?: string[];
  children_pi_remove?: string[];
  note?: string;
}

export interface AppendVersionResponse {
  id: string;                            // Entity ID
  ver: number;
  manifest_cid: string;
  tip: string;
}

/**
 * IPFS Wrapper Client for interacting with arke-ipfs-api service
 */
export class IPFSWrapperClient {
  constructor(private ipfsWrapper: Fetcher) {}

  /**
   * Generic CAS retry wrapper - fetches tip and retries on conflicts
   * Handles exponential backoff with jitter to avoid thundering herd
   */
  private async executeWithCASRetry<T>(
    pi: string,
    operation: (tip: string) => Promise<Response>,
    operationName: string,
    options = { maxRetries: 5, baseDelay: 50 }
  ): Promise<T> {
    for (let attempt = 0; attempt < options.maxRetries; attempt++) {
      try {
        // Fetch current tip for CAS operation
        const currentTip = await this.getEntityTip(pi);

        // Execute operation with current tip
        const response = await operation(currentTip);

        // Handle CAS conflict (409) with retry
        if (response.status === 409) {
          if (attempt < options.maxRetries - 1) {
            // Exponential backoff with jitter to avoid thundering herd
            const exponentialDelay = options.baseDelay * Math.pow(2, attempt);
            const jitter = Math.random() * exponentialDelay * 0.5; // 0-50% jitter
            const delay = Math.min(1000, exponentialDelay + jitter);

            console.log(
              `[CAS Retry] ${operationName} attempt ${attempt + 1}/${options.maxRetries} failed for ${pi}, retrying in ${Math.round(delay)}ms...`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          // Final retry exhausted
          const error = await response.text();
          throw new Error(`CAS conflict after ${options.maxRetries} retries: ${error}`);
        }

        // Handle other errors
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`${operationName} error ${response.status}: ${error}`);
        }

        return await response.json();
      } catch (error: any) {
        // If this is the last attempt, re-throw
        if (attempt === options.maxRetries - 1) {
          throw new Error(
            `${operationName} failed for ${pi} after ${options.maxRetries} retries: ${error.message}`
          );
        }

        // For non-409 errors on non-final attempts, still retry with backoff
        if (!error.message?.includes('CAS conflict')) {
          const exponentialDelay = options.baseDelay * Math.pow(2, attempt);
          const jitter = Math.random() * exponentialDelay * 0.5;
          const delay = Math.min(1000, exponentialDelay + jitter);

          console.log(
            `[Retry] ${operationName} attempt ${attempt + 1}/${options.maxRetries} failed for ${pi}, retrying in ${Math.round(delay)}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
    }

    // Should never reach here, but TypeScript needs this
    throw new Error(`${operationName} failed for ${pi} after ${options.maxRetries} retries`);
  }

  /**
   * Create a new entity with v1 snapshot
   */
  async createEntity(request: CreateEntityRequest): Promise<CreateEntityResponse> {
    const response = await this.ipfsWrapper.fetch('https://api/entities', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`IPFS wrapper error ${response.status}: ${error}`);
    }

    return await response.json();
  }

  /**
   * Append a new version to an existing entity
   * Automatically fetches current tip and retries on CAS conflicts with exponential backoff
   */
  async appendVersion(
    request: AppendVersionRequest,
    options = { maxRetries: 5, baseDelay: 50 }
  ): Promise<AppendVersionResponse> {
    return this.executeWithCASRetry<AppendVersionResponse>(
      request.pi,
      (currentTip) =>
        this.ipfsWrapper.fetch(`https://api/entities/${request.pi}/versions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            expect_tip: currentTip,
            components: request.components,
            components_remove: request.components_remove,
            children_pi_add: request.children_pi_add,
            children_pi_remove: request.children_pi_remove,
            note: request.note,
          }),
        }),
      'appendVersion',
      options
    );
  }

  /**
   * Upload raw content to IPFS and get CID
   */
  async uploadContent(content: string, filename?: string): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([content]), filename || 'file.txt');

    const response = await this.ipfsWrapper.fetch('https://api/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`IPFS upload error ${response.status}: ${error}`);
    }

    const results: any = await response.json();
    return results[0].cid;
  }

  /**
   * Get entity tip CID for CAS
   */
  async getEntityTip(pi: string): Promise<string> {
    const response = await this.ipfsWrapper.fetch(`https://api/resolve/${pi}`);

    if (!response.ok) {
      throw new Error(`Failed to resolve PI ${pi}: ${response.status}`);
    }

    const data: any = await response.json();
    return data.tip;
  }

  /**
   * Get full entity data (manifest)
   */
  async getEntity(pi: string): Promise<{
    pi: string;
    tip: string;
    ver: number;
    components: Record<string, string>;
    children_pi: string[];
    parent_pi?: string;
  }> {
    const response = await this.ipfsWrapper.fetch(`https://api/entities/${pi}`);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get entity ${pi}: ${error}`);
    }

    const result: any = await response.json();
    return result;
  }

  /**
   * Add a child to a parent entity (bidirectional relationship)
   * Simplified wrapper for single-child additions
   */
  async addChildToParent(
    params: { parent_pi: string; child_pi: string },
    options = { maxRetries: 5, baseDelay: 50 }
  ): Promise<void> {
    await this.executeWithCASRetry<AppendVersionResponse>(
      params.parent_pi,
      (currentTip) =>
        this.ipfsWrapper.fetch('https://api/relations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            parent_pi: params.parent_pi,
            expect_tip: currentTip,
            add_children: [params.child_pi],
            note: 'Added child entity',
          }),
        }),
      'addChildToParent',
      options
    );
  }

  /**
   * Update parent-child relationships (bidirectional, bulk operation)
   */
  async updateRelations(
    params: {
      parent_pi: string;
      add_children?: string[];
      remove_children?: string[];
      note?: string;
    },
    options = { maxRetries: 5, baseDelay: 50 }
  ): Promise<AppendVersionResponse> {
    return this.executeWithCASRetry<AppendVersionResponse>(
      params.parent_pi,
      (currentTip) =>
        this.ipfsWrapper.fetch('https://api/relations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            parent_pi: params.parent_pi,
            expect_tip: currentTip,
            add_children: params.add_children,
            remove_children: params.remove_children,
            note: params.note,
          }),
        }),
      'updateRelations',
      options
    );
  }
}
