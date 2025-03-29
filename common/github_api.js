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
        // Allowing non-github.com hostnames for potential enterprise use
        // if (url.hostname !== 'github.com') {
        //     console.warn("[GitHub API] URL is not a standard github.com URL:", repoUrl);
        // }
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
 * @param {object} [options={}] - Optional fetch options (method, headers, body, etc.).
 * @returns {Promise<Response>} - The raw fetch Response object.
 * @throws {Error} If the request fails or returns an error status code.
 */
async function makeApiRequest(url, options = {}) {
    console.log(`[GitHub API] Making request to: ${url}`);
    const headers = { ...options.headers, 'Accept': 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' }; // Added API version header - recommended practice
    let response;

    try {
        const pat = await getGitHubPat();
        if (pat) {
            console.log("[GitHub API] Using PAT for authentication.");
            headers['Authorization'] = `Bearer ${pat}`; // Changed from 'token' to 'Bearer' (both work, Bearer is more standard)
        } else {
            console.log("[GitHub API] No PAT found, making unauthenticated request.");
        }

        response = await fetch(url, { ...options, headers });

        console.log(`[GitHub API] Request to ${url} completed with status: ${response.status}`);

        // Check for error statuses
        if (!response.ok) {
            let errorData;
            let errorMessage = `GitHub API request failed: ${response.status} ${response.statusText}. URL: ${url}.`;
            try {
                errorData = await response.json();
                errorMessage += ` Message: ${errorData.message || 'No specific message in error response.'}`;
                console.error(`[GitHub API] Error Response Body:`, JSON.stringify(errorData, null, 2)); // Log the actual error body
            } catch (parseError) {
                errorMessage += ' Additionally, failed to parse error response body.';
                console.error(`[GitHub API] Failed to parse error response body for status ${response.status}`);
            }
            throw new Error(errorMessage);
        }

        return response;

    } catch (error) {
        // Catch fetch errors (network issues) or errors thrown from !response.ok or PAT retrieval
        console.error(`[GitHub API] API request process failed for ${url}:`, error);
        // Re-throw the error to be handled by the caller, potentially adding context if needed
        throw new Error(`API request failed for ${url}. ${error.message}`);
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
            console.error("[GitHub API] Default branch property missing in repo info:", repoInfo);
            throw new Error("Could not determine default branch from repository info.");
        }
        console.log(`[GitHub API] Default branch for ${owner}/${repo}: ${repoInfo.default_branch}`);
        return repoInfo.default_branch;
    } catch (error) {
        console.error(`[GitHub API] Error fetching default branch for ${owner}/${repo}:`, error);
        // Propagate a more specific error
        throw new Error(`Failed to get default branch for ${owner}/${repo}. Cause: ${error.message}`);
    }
}


/**
 * Fetches the file tree for a repository recursively.
 * Returns both the tree data and a flag indicating if it was truncated.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @returns {Promise<{tree: Array<object>, truncated: boolean}>} - A promise resolving to an object containing the tree items and truncation status.
 * @throws {Error} If the request fails or the tree data is invalid.
 */
async function getRepoTree(owner, repo) {
    console.log(`[GitHub API] Fetching repository tree for ${owner}/${repo}`);
    try {
        const defaultBranch = await getDefaultBranch(owner, repo);
        const treeUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
        console.log(`[GitHub API] Fetching tree using URL: ${treeUrl}`);

        const response = await makeApiRequest(treeUrl);
        const treeData = await response.json();

        // Explicitly check for the tree array before accessing truncated flag
        if (!treeData || !Array.isArray(treeData.tree)) {
            console.error("[GitHub API] Invalid tree data structure received:", treeData);
            throw new Error("Invalid tree data received from GitHub API (missing 'tree' array).");
        }

        const isTruncated = !!treeData.truncated; // Ensure boolean

        if (isTruncated) {
            console.warn(`[GitHub API] Warning: Repository tree for ${owner}/${repo} was truncated. Not all files may be listed.`);
            // Note: We are now returning the truncation status explicitly.
        }

        console.log(`[GitHub API] Successfully fetched tree with ${treeData.tree.length} items for ${owner}/${repo}. Truncated: ${isTruncated}`);
        return { tree: treeData.tree, truncated: isTruncated }; // Return object structure

    } catch (error) {
        console.error(`[GitHub API] Error fetching repository tree for ${owner}/${repo}:`, error);
        // Re-throw a more specific error message
        throw new Error(`Failed to fetch repository tree for ${owner}/${repo}. Cause: ${error.message}`);
    }
}


/**
 * Fetches the content of a specific file (blob) using its SHA.
 * Handles potentially empty files correctly.
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

        // *** MODIFIED CHECK ***
        // Check if content is explicitly null/undefined OR if encoding is not base64.
        // Allows content to be an empty string "" (which is valid for empty files).
        if (blobData.content == null || blobData.encoding !== 'base64') {
            // Log the actual received data for better debugging
            console.error(`[GitHub API] Invalid or incompatible blob data received for SHA ${fileSha}:`, JSON.stringify(blobData, null, 2));
            throw new Error(`Invalid, missing, or non-base64 content for blob SHA ${fileSha}. Received encoding: ${blobData.encoding}. Content present: ${blobData.content != null}.`);
        }

        // Decode Base64 content. atob('') returns '', which is correct for empty files.
        const decodedContent = atob(blobData.content);
        console.log(`[GitHub API] Successfully fetched and decoded content for SHA: ${fileSha} (Length: ${decodedContent.length})`);
        return decodedContent;

    } catch (error) {
        // Log the specific error during blob fetching/decoding
        console.error(`[GitHub API] Error processing file content for SHA ${fileSha}:`, error);
        // Throw a new error with context
        throw new Error(`Failed to get or decode file content for SHA ${fileSha}. Cause: ${error.message}`);
    }
}

// Export the functions needed by other modules
export {
    parseRepoUrl,
    getRepoTree,
    getFileContentBySha
    // Internal helpers like makeApiRequest and getDefaultBranch are not exported.
};

console.log("[GitHub API] Module loaded.");