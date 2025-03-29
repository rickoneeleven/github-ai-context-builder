// Import the PAT getter from storage.js
import { getGitHubPat } from './storage.js';

console.log("[GitHub API] Module loading...");

const GITHUB_API_BASE_URL = 'https://api.github.com';

/**
 * Extracts the owner and repository name from a GitHub URL.
 * @param {string} repoUrl - The full URL of the GitHub repository (e.g., https://github.com/owner/repo/tree/main).
 * @returns {{owner: string, repo: string} | null} - An object with owner and repo, or null if parsing fails.
 */
function parseRepoUrl(repoUrl) {
    console.log(`[GitHub API] Parsing URL: ${repoUrl}`);
    try {
        const url = new URL(repoUrl);
        if (url.hostname !== 'github.com') {
            console.warn("[GitHub API] URL is not a standard github.com URL:", repoUrl);
            // Allow for potential GitHub Enterprise, but might need adjustments later.
        }
        const pathParts = url.pathname.split('/').filter(part => part.length > 0); // Filter empty parts

        if (pathParts.length >= 2) {
            const owner = pathParts[0];
            const repo = pathParts[1];
            console.log(`[GitHub API] Parsed owner: ${owner}, repo: ${repo}`);
            return { owner, repo };
        } else {
            console.error("[GitHub API] Could not parse owner/repo from path:", url.pathname);
            return null;
        }
    } catch (error) {
        console.error("[GitHub API] Invalid URL provided for parsing:", repoUrl, error);
        return null;
    }
}


/**
 * Makes an authenticated request to the GitHub API.
 * Handles fetching the PAT and adding the Authorization header.
 * @param {string} url - The full API endpoint URL.
 * @param {object} options - Optional fetch options (method, headers, body, etc.).
 * @returns {Promise<Response>} - The raw fetch Response object.
 * @throws {Error} If the request fails or returns an error status code.
 */
async function makeApiRequest(url, options = {}) {
    console.log(`[GitHub API] Making request to: ${url}`);
    let headers = { ...options.headers, 'Accept': 'application/vnd.github.v3+json' };
    let response;

    try {
        const pat = await getGitHubPat();
        if (pat) {
            console.log("[GitHub API] Using PAT for authentication.");
            headers['Authorization'] = `token ${pat}`;
        } else {
            console.log("[GitHub API] No PAT found, making unauthenticated request.");
        }

        response = await fetch(url, { ...options, headers });

        console.log(`[GitHub API] Request to ${url} completed with status: ${response.status}`);

        // Check for common error statuses
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Failed to parse error response.' }));
            const errorMessage = `GitHub API request failed: ${response.status} ${response.statusText}. URL: ${url}. Message: ${errorData.message || 'No message'}`;
            console.error(`[GitHub API] Error Response:`, errorData);
            throw new Error(errorMessage);
            // Note: We are not automatically prompting for PAT here like in the original background.js.
            // The user needs to set it via the options page. Errors will be surfaced to the UI.
        }

        return response;

    } catch (error) {
        // Catch fetch errors (network issues) or errors thrown from !response.ok
        console.error(`[GitHub API] Fetch failed for ${url}:`, error);
        // Re-throw the error to be handled by the caller
        throw error;
    }
}

/**
 * Fetches the default branch for a repository.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @returns {Promise<string>} - The name of the default branch.
 * @throws {Error} If the request fails.
 */
async function getDefaultBranch(owner, repo) {
    const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}`;
    console.log(`[GitHub API] Fetching default branch for ${owner}/${repo}`);
    try {
        const response = await makeApiRequest(url);
        const repoInfo = await response.json();
        if (!repoInfo.default_branch) {
            throw new Error("Could not determine default branch from repository info.");
        }
        console.log(`[GitHub API] Default branch for ${owner}/${repo}: ${repoInfo.default_branch}`);
        return repoInfo.default_branch;
    } catch (error) {
        console.error(`[GitHub API] Error fetching default branch for ${owner}/${repo}:`, error);
        throw new Error(`Failed to get default branch for ${owner}/${repo}. ${error.message}`);
    }
}


/**
 * Fetches the file tree for a repository recursively.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @returns {Promise<Array<object>>} - A promise that resolves to the array of tree items (files and blobs).
 * @throws {Error} If the request fails or the tree is truncated unexpectedly.
 */
async function getRepoTree(owner, repo) {
    console.log(`[GitHub API] Fetching repository tree for ${owner}/${repo}`);
    try {
        const defaultBranch = await getDefaultBranch(owner, repo);
        // Use the default branch SHA for potentially more stable results, but requires an extra call.
        // Or just use the branch name directly (simpler). Let's use the name for now.
        // const branchInfoUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/branches/${defaultBranch}`;
        // const branchResponse = await makeApiRequest(branchInfoUrl);
        // const branchData = await branchResponse.json();
        // const treeSha = branchData.commit.sha;

        const treeUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
        console.log(`[GitHub API] Fetching tree using URL: ${treeUrl}`);

        const response = await makeApiRequest(treeUrl);
        const treeData = await response.json();

        if (treeData.truncated) {
            // This is a limitation. For very large repos, we might not get all files.
            // We should inform the user if this happens.
            console.warn(`[GitHub API] Warning: Repository tree for ${owner}/${repo} was truncated. Not all files may be listed.`);
            // Decide how to handle this - throw error, or return partial tree with warning?
            // For now, let's return the partial tree, but the UI should ideally indicate this.
            // throw new Error(`Repository tree is too large and was truncated by the GitHub API.`);
        }

        if (!treeData.tree || !Array.isArray(treeData.tree)) {
             throw new Error("Invalid tree data received from GitHub API.");
        }

        console.log(`[GitHub API] Successfully fetched tree with ${treeData.tree.length} items for ${owner}/${repo}. Truncated: ${treeData.truncated}`);
        // We only care about files ('blob') for content fetching. Folders ('tree') help structure.
        // Filter here or in the caller? Let's return the full tree for now, caller can filter.
        // Example item: { path: 'src/main.js', mode: '100644', type: 'blob', sha: '...', size: 1234, url: '...' }
        return treeData.tree;

    } catch (error) {
        console.error(`[GitHub API] Error fetching repository tree for ${owner}/${repo}:`, error);
        // Re-throw a more specific error message
        throw new Error(`Failed to fetch repository tree for ${owner}/${repo}. ${error.message}`);
    }
}


/**
 * Fetches the content of a specific file (blob) using its SHA.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {string} fileSha - The SHA hash of the file blob.
 * @returns {Promise<string>} - A promise that resolves to the decoded file content (UTF-8).
 * @throws {Error} If the request fails or content cannot be decoded.
 */
async function getFileContentBySha(owner, repo, fileSha) {
    const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/git/blobs/${fileSha}`;
    console.log(`[GitHub API] Fetching file content for SHA: ${fileSha} in ${owner}/${repo}`);

    try {
        const response = await makeApiRequest(url);
        const blobData = await response.json();

        if (!blobData.content || blobData.encoding !== 'base64') {
            console.error("[GitHub API] Invalid blob data received:", blobData);
            throw new Error(`Invalid or missing content for blob SHA ${fileSha}. Encoding was ${blobData.encoding}.`);
        }

        // Decode Base64 content
        const decodedContent = atob(blobData.content);
        console.log(`[GitHub API] Successfully fetched and decoded content for SHA: ${fileSha}`);
        return decodedContent;

    } catch (error) {
        console.error(`[GitHub API] Error fetching file content for SHA ${fileSha}:`, error);
        throw new Error(`Failed to get file content for SHA ${fileSha}. ${error.message}`);
    }
}

// Export the functions needed by other modules (likely popup.js)
export {
    parseRepoUrl,
    getRepoTree,
    getFileContentBySha
    // We don't export getDefaultBranch or makeApiRequest directly, they are internal helpers.
};

console.log("[GitHub API] Module loaded.");