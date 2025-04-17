// File: common/github_api.js
// Import the PAT getter from storage.js
import { getGitHubPat } from './storage.js';

// Minimal logging during module load
// console.log("[GitHub API] Module loading...");

const GITHUB_API_BASE_URL = 'https://api.github.com';

/**
 * Extracts owner, repository name, and reference (branch/tag/commit SHA) from a GitHub URL.
 * Handles URLs like:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch-name
 * - https://github.com/owner/repo/blob/tag-name/path/to/file
 * - https://github.com/owner/repo/commit/sha12345
 * @param {string} repoUrl - The full URL of the GitHub repository page.
 * @returns {{owner: string, repo: string, ref: string | null} | null} - Object with owner, repo, and ref (or null if default), or null if parsing fails.
 */
function parseRepoUrl(repoUrl) {
    console.log(`[GitHub API] Parsing URL for repo info: ${repoUrl}`);
    try {
        const url = new URL(repoUrl);
        const pathParts = url.pathname.split('/').filter(part => part.length > 0); // Filter empty parts

        if (pathParts.length >= 2) {
            const owner = pathParts[0];
            const repo = pathParts[1];
            let ref = null; // Default to null (implies default branch)

            // Check for ref indicators like /tree/, /blob/, /commit/
            // Ref is typically the part *after* these indicators.
            if (pathParts.length > 3 && (pathParts[2] === 'tree' || pathParts[2] === 'blob' || pathParts[2] === 'commit')) {
                ref = pathParts[3];
            }
            // Basic tag check (less common URL structure, but possible)
            else if (pathParts.length > 2 && pathParts[2] === 'releases' && pathParts[3] === 'tag') {
                // Usually tags point to releases, not trees directly in this common URL structure,
                // but might be used for specific tag views. Let's capture it if present.
                if(pathParts.length > 4) {
                    ref = pathParts[4];
                }
            }
            // Add more specific checks if other URL patterns need explicit ref handling

            console.log(`[GitHub API] Parsed owner: ${owner}, repo: ${repo}, ref: ${ref}`);
            return { owner, repo, ref };
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
    // Reduced logging for less noise
    // console.log(`[GitHub API] Making request to: ${url}`);
    const headers = { ...options.headers, 'Accept': 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' };
    let response;

    try {
        const pat = await getGitHubPat();
        if (pat) {
            // console.log("[GitHub API] Using PAT for authentication.");
            headers['Authorization'] = `Bearer ${pat}`;
        } else {
            // console.log("[GitHub API] No PAT found, making unauthenticated request.");
        }

        response = await fetch(url, { ...options, headers });

        console.log(`[GitHub API] Request to ${url.split('?')[0]} completed with status: ${response.status}`); // Log URL without query params for brevity

        if (!response.ok) {
            let errorData;
            let errorMessage = `GitHub API request failed: ${response.status} ${response.statusText}. URL: ${url}.`;
            try {
                errorData = await response.json();
                errorMessage += ` Message: ${errorData.message || 'No specific message in error response.'}`;
                console.error(`[GitHub API] Error Response Body (Status ${response.status}):`, JSON.stringify(errorData, null, 2));
            } catch (parseError) {
                errorMessage += ' Additionally, failed to parse error response body.';
                console.error(`[GitHub API] Failed to parse error response body for status ${response.status}`);
            }
            throw new Error(errorMessage);
        }

        return response;

    } catch (error) {
        console.error(`[GitHub API] API request process failed for ${url}:`, error);
        throw new Error(`API request failed for ${url}. ${error.message}`);
    }
}

/**
 * Fetches the default branch for a repository. Used internally if no specific ref is requested.
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
        throw new Error(`Failed to get default branch for ${owner}/${repo}. Cause: ${error.message}`);
    }
}


/**
 * Fetches the file tree for a repository recursively, optionally for a specific ref.
 * Returns both the tree data and a flag indicating if it was truncated.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {string | null} [ref=null] - Optional branch, tag, or commit SHA. If null, uses the default branch.
 * @returns {Promise<{tree: Array<object>, truncated: boolean, ref: string}>} - A promise resolving to an object containing the tree items, truncation status, and the ref actually used.
 * @throws {Error} If the request fails or the tree data is invalid.
 */
async function getRepoTree(owner, repo, ref = null) {
    console.log(`[GitHub API] Fetching repository tree for ${owner}/${repo}${ref ? ` (ref: ${ref})` : ' (default branch)'}`);
    try {
        let refToUse = ref;
        if (!refToUse) {
            console.log(`[GitHub API] No ref specified, fetching default branch name...`);
            refToUse = await getDefaultBranch(owner, repo);
            console.log(`[GitHub API] Using default branch: ${refToUse}`);
        }

        // Construct the tree URL using the determined ref
        const treeUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/git/trees/${refToUse}?recursive=1`;
        console.log(`[GitHub API] Fetching tree using URL: ${treeUrl.split('?')[0]}`); // Log URL without query params

        const response = await makeApiRequest(treeUrl);
        const treeData = await response.json();

        if (!treeData || !Array.isArray(treeData.tree)) {
            // Check if it might be a commit response instead of a tree response (if ref was a commit SHA)
            if (treeData && treeData.commit && treeData.tree && treeData.tree.sha) {
                 console.warn(`[GitHub API] Ref '${refToUse}' pointed to a commit, not a tree directly. Attempting to use commit's tree SHA.`);
                 // Fetch the tree using the commit's tree SHA
                 const commitTreeUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/git/trees/${treeData.tree.sha}?recursive=1`;
                 console.log(`[GitHub API] Re-fetching tree using commit's tree SHA URL: ${commitTreeUrl.split('?')[0]}`);
                 const commitTreeResponse = await makeApiRequest(commitTreeUrl);
                 const commitTreeData = await commitTreeResponse.json();

                 if (!commitTreeData || !Array.isArray(commitTreeData.tree)) {
                     console.error("[GitHub API] Invalid tree data structure received even after using commit's tree SHA:", commitTreeData);
                     throw new Error("Invalid tree data received from GitHub API (missing 'tree' array after commit lookup).");
                 }
                 // Use the data from the commit's tree
                 treeData.tree = commitTreeData.tree;
                 treeData.truncated = commitTreeData.truncated; // Ensure truncated status is also taken
            } else {
                console.error("[GitHub API] Invalid tree data structure received:", treeData);
                throw new Error(`Invalid tree data received from GitHub API (missing 'tree' array or unexpected structure for ref '${refToUse}').`);
            }
        }

        const isTruncated = !!treeData.truncated; // Ensure boolean

        if (isTruncated) {
            console.warn(`[GitHub API] Warning: Repository tree for ${owner}/${repo} (ref: ${refToUse}) was truncated. Not all files may be listed.`);
        }

        console.log(`[GitHub API] Successfully fetched tree with ${treeData.tree.length} items for ${owner}/${repo} (ref: ${refToUse}). Truncated: ${isTruncated}`);
        // Return the ref actually used along with the tree data
        return { tree: treeData.tree, truncated: isTruncated, ref: refToUse };

    } catch (error) {
        console.error(`[GitHub API] Error fetching repository tree for ${owner}/${repo} (ref: ${ref || 'default'}):`, error);
        throw new Error(`Failed to fetch repository tree for ${owner}/${repo}${ref ? ` (ref: ${ref})` : ''}. Cause: ${error.message}`);
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
    // Reduced logging
    // console.log(`[GitHub API] Fetching file content for SHA: ${fileSha} in ${owner}/${repo}`);

    try {
        const response = await makeApiRequest(url);
        const blobData = await response.json();

        if (blobData.content == null || blobData.encoding !== 'base64') {
            console.error(`[GitHub API] Invalid or incompatible blob data received for SHA ${fileSha}:`, JSON.stringify(blobData, null, 2));
            throw new Error(`Invalid, missing, or non-base64 content for blob SHA ${fileSha}. Received encoding: ${blobData.encoding}. Content present: ${blobData.content != null}.`);
        }

        const decodedContent = atob(blobData.content);
        // Reduced logging
        // console.log(`[GitHub API] Successfully fetched and decoded content for SHA: ${fileSha} (Length: ${decodedContent.length})`);
        return decodedContent;

    } catch (error) {
        console.error(`[GitHub API] Error processing file content for SHA ${fileSha}:`, error);
        throw new Error(`Failed to get or decode file content for SHA ${fileSha}. Cause: ${error.message}`);
    }
}

export {
    parseRepoUrl,
    getRepoTree,
    getFileContentBySha
    // Internal helpers like makeApiRequest and getDefaultBranch are not exported.
};