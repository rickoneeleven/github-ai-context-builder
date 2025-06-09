// File: common/github_api.js
// Import the PAT getter from storage.js
import { getGitHubPat } from './storage.js';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const BASE_REPO_URL_REGEX = /\/repos\/[^\/]+\/[^\/]+$/; // Regex to match '/repos/owner/repo' at the end

/**
 * Custom error class for specific API errors like auth issues on private repos.
 */
class ApiAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = "ApiAuthError";
    }
}


/**
 * Extracts owner, repository name, and reference (branch/tag/commit SHA) from a GitHub URL.
 * @param {string} repoUrl - The full URL of the GitHub repository page.
 * @returns {{owner: string, repo: string, ref: string | null} | null} - Object with owner, repo, and ref (or null if default), or null if parsing fails.
 */
function parseRepoUrl(repoUrl) {
    try {
        const url = new URL(repoUrl);
        const pathParts = url.pathname.split('/').filter(part => part.length > 0);

        if (pathParts.length >= 2) {
            const owner = pathParts[0];
            const repo = pathParts[1];
            let ref = null;

            if (pathParts.length > 3 && (pathParts[2] === 'tree' || pathParts[2] === 'blob' || pathParts[2] === 'commit')) {
                ref = pathParts[3];
            }
            else if (pathParts.length > 2 && pathParts[2] === 'releases' && pathParts[3] === 'tag') {
                 if(pathParts.length > 4) {
                    ref = pathParts[4];
                }
            }

            return { owner, repo, ref };
        } else {
            console.error("[GitHub API] Could not parse owner/repo from path:", url.pathname); // Keep error for bad parse
            return null;
        }
    } catch (error) {
        console.error("[GitHub API] Invalid URL provided for parsing:", repoUrl, error); // Keep error for invalid URL
        return null;
    }
}


/**
 * Makes an authenticated request to the GitHub API.
 * @param {string} url - The full API endpoint URL.
 * @param {object} [options={}] - Optional fetch options (method, headers, body, etc.).
 * @returns {Promise<Response>} - The raw fetch Response object.
 * @throws {Error | ApiAuthError} If the request fails or returns an error status code. Throws ApiAuthError for 404 on base repo URL.
 */
async function makeApiRequest(url, options = {}) {
    const headers = { ...options.headers, 'Accept': 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' };
    let response;

    try {
        const pat = await getGitHubPat();
        if (pat) {
            headers['Authorization'] = `Bearer ${pat}`;
        }

        response = await fetch(url, { ...options, headers });

        if (!response.ok) {
            let errorData;
            let errorMessage = `GitHub API request failed: ${response.status} ${response.statusText}. URL: ${url}.`;
            try {
                errorData = await response.json();
                errorMessage += ` Message: ${errorData.message || 'No specific message in error response.'}`;
                // Raw body log removed previously
            } catch (parseError) {
                errorMessage += ' Additionally, failed to parse error response body.';
                console.error(`[GitHub API] Failed to parse error response body for status ${response.status}`); // Keep this error
            }

            // Check if it's a 404 on the base repo endpoint
            if (response.status === 404 && BASE_REPO_URL_REGEX.test(url)) {
                 // --- MODIFIED LINE: Changed console.warn to console.log ---
                 console.log(`[GitHub API] Received 404 on base repo URL: ${url}. Likely a private repo/auth issue.`);
                 throw new ApiAuthError(errorMessage + " (Likely private repository or insufficient PAT permissions)");
            }

            // Throw generic error for other failures (will be logged as error below)
            throw new Error(errorMessage);
        }

        return response;

    } catch (error) {
        // Log ONLY if it's NOT the specific handled ApiAuthError.
        if (!(error instanceof ApiAuthError)) {
             console.error(`[GitHub API] API request process failed for ${url}:`, error); // Keep error for unexpected fetch issues
        }
        // Re-throw the original error
        throw error;
    }
}

/**
 * Fetches the default branch for a repository.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @returns {Promise<string>} - The name of the default branch.
 * @throws {Error | ApiAuthError} If the request fails.
 */
async function getDefaultBranch(owner, repo) {
    const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}`;
    try {
        const response = await makeApiRequest(url); // Can throw ApiAuthError
        const repoInfo = await response.json();
        if (!repoInfo.default_branch) {
            console.error("[GitHub API] Default branch property missing in repo info:", repoInfo); // Keep error for unexpected API response
            throw new Error("Could not determine default branch from repository info.");
        }
        return repoInfo.default_branch;
    } catch (error) {
        // Log only unexpected errors
        if (!(error instanceof ApiAuthError)) {
            console.error(`[GitHub API] Error fetching default branch for ${owner}/${repo}:`, error); // Keep error
        }
        throw error; // Propagate
    }
}


/**
 * Fetches the file tree for a repository recursively, optionally for a specific ref.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {string | null} [ref=null] - Optional branch, tag, or commit SHA. If null, uses the default branch.
 * @returns {Promise<{tree: Array<object>, truncated: boolean, ref: string}>} - A promise resolving to an object containing the tree items, truncation status, and the ref actually used.
 * @throws {Error | ApiAuthError} If the request fails or the tree data is invalid.
 */
async function getRepoTree(owner, repo, ref = null) {
    try {
        let refToUse = ref;
        if (!refToUse) {
            refToUse = await getDefaultBranch(owner, repo); // Can throw ApiAuthError
        }

        const treeUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/git/trees/${refToUse}?recursive=1`;

        const response = await makeApiRequest(treeUrl); // Can throw ApiAuthError or other errors
        const treeData = await response.json();

        if (!treeData || !Array.isArray(treeData.tree)) {
            if (treeData?.commit?.tree?.sha) {
                 const commitTreeUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/git/trees/${treeData.tree.sha}?recursive=1`;
                 const commitTreeResponse = await makeApiRequest(commitTreeUrl); // Can throw ApiAuthError or other errors
                 const commitTreeData = await commitTreeResponse.json();

                 if (!commitTreeData || !Array.isArray(commitTreeData.tree)) {
                     console.error("[GitHub API] Invalid tree data structure received even after using commit's tree SHA:", commitTreeData); // Keep error
                     throw new Error("Invalid tree data received from GitHub API (missing 'tree' array after commit lookup).");
                 }
                 treeData.tree = commitTreeData.tree;
                 treeData.truncated = commitTreeData.truncated;
            } else {
                console.error("[GitHub API] Invalid tree data structure received:", treeData); // Keep error
                throw new Error(`Invalid tree data received from GitHub API (missing 'tree' array or unexpected structure for ref '${refToUse}').`);
            }
        }

        const isTruncated = !!treeData.truncated;

        if (isTruncated) {
            // Keep as warn, truncation is potentially problematic for the user's goal
            console.warn(`[GitHub API] Warning: Repository tree for ${owner}/${repo} (ref: ${refToUse}) was truncated. Not all files may be listed.`);
        }

        return { tree: treeData.tree, truncated: isTruncated, ref: refToUse };

    } catch (error) {
        // Log only unexpected errors
        if (!(error instanceof ApiAuthError)) {
            console.error(`[GitHub API] Error fetching repository tree for ${owner}/${repo} (ref: ${ref || 'default'}):`, error); // Keep error
        }
        throw error; // Propagate
    }
}


/**
 * Fetches the content of a specific file (blob) using its SHA.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {string} fileSha - The SHA hash of the file blob.
 * @returns {Promise<string>} - A promise that resolves to the decoded file content (UTF-8).
 * @throws {Error | ApiAuthError} If the request fails or content cannot be decoded.
 */
async function getFileContentBySha(owner, repo, fileSha) {
    const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/git/blobs/${fileSha}`;

    try {
        const response = await makeApiRequest(url); // Can throw ApiAuthError or other errors
        const blobData = await response.json();

        if (blobData.content === null || blobData.content === undefined || blobData.encoding !== 'base64') {
            if (blobData.size === 0 && blobData.content === "") {
                 return ""; // Handle empty files
            }
            console.error(`[GitHub API] Invalid or incompatible blob data received for SHA ${fileSha}:`, JSON.stringify(blobData, null, 2)); // Keep error
            throw new Error(`Invalid, missing, or non-base64 content for blob SHA ${fileSha}. Received encoding: ${blobData.encoding}. Content present: ${blobData.content != null}. Size: ${blobData.size}`);
        }

        const decodedContent = atob(blobData.content);
        return decodedContent;

    } catch (error) {
        // Log only unexpected errors
        if (!(error instanceof ApiAuthError)) {
            console.error(`[GitHub API] Error processing file content for SHA ${fileSha}:`, error); // Keep error
        }
        throw error; // Propagate
    }
}

export {
    parseRepoUrl,
    getRepoTree,
    getFileContentBySha,
    ApiAuthError
};