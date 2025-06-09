// File: popup/actions.js
import { log } from './popup_utils.js';
import * as ui from './popup_ui.js';
import { getFileContentBySha } from '../common/github_api.js';
// ASSUMPTION: Tokenizer library is available and bundled correctly.
// Replace with actual path if using a local/vendored copy.
import { encode } from 'gpt-tokenizer'; // Or your chosen tokenizer library

// console.log("[Popup Actions] Module loading..."); // Removed module load noise

// --- Constants ---
const CONTEXT_PREFIX_PATH = 'assets/context_prefix.txt';
const MAX_TOKENIZER_CHARS = 1_000_000; // Safety limit for tokenizer input length to prevent crashes

// --- Module State ---
// Callbacks to get necessary data/trigger actions in the main module
let getRepoInfo = null;
let getSelectionState = null;
let getFileTreeData = null;
let triggerRefresh = null;

// --- Private Helper Functions ---

/**
 * Fetches the context prefix string from the assets file.
 * @returns {Promise<string>} The prefix string (with trailing newlines) or an empty string if fetch fails.
 */
async function getContextPrefix() {
    try {
        const prefixUrl = chrome.runtime.getURL(CONTEXT_PREFIX_PATH);
        // log('info', `[Actions] Fetching context prefix from: ${prefixUrl}`); // Too verbose
        const response = await fetch(prefixUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch prefix: ${response.status} ${response.statusText}`);
        }
        const prefixText = await response.text();
        // log('info', "[Actions] Successfully fetched context prefix."); // Too verbose
        // Ensure consistent formatting with trailing newlines if not empty
        return prefixText.trim() ? prefixText.trimEnd() + '\n\n' : "";
    } catch (error) {
        log('error', `[Actions] Error fetching context prefix from ${CONTEXT_PREFIX_PATH}:`, error);
        ui.showError(`Error loading context prefix: ${error.message}. Ensure '${CONTEXT_PREFIX_PATH}' exists.`);
        return ""; // Return empty string on failure
    }
}

/**
 * Attempts to send a system notification.
 * @param {string} title - Notification title.
 * @param {string} message - Notification message.
 */
async function notifyUser(title, message) {
    // Basic check for API existence first
    if (!chrome.notifications?.create) {
        // log('warn', '[Actions] Notifications API not available or create method missing.'); // Warn only if expected
        return;
    }
     try {
        // Check permission using promises for cleaner async flow
        const hasPermission = await new Promise((resolve) => {
             if (chrome.permissions?.contains) {
                 chrome.permissions.contains({ permissions: ['notifications'] }, (granted) => {
                    // Check for runtime errors after checking permission
                    if (chrome.runtime.lastError) {
                        log('warn', '[Actions] Error checking notification permission:', chrome.runtime.lastError.message);
                        resolve(false); // Assume no permission if error occurs
                    } else {
                        resolve(granted);
                    }
                 });
             } else {
                 // If permissions API isn't available, we can't reliably check.
                 // Proceeding might work if permission was granted some other way,
                 // but it's safer to log a warning and potentially resolve false.
                 // Let's assume true for now but log the inability to check.
                 log('warn', '[Actions] Cannot verify notification permission via chrome.permissions API.');
                 resolve(true);
             }
        });

         if (hasPermission) {
              const iconUrl = chrome.runtime.getURL('icons/icon48.png'); // Ensure this icon exists
              chrome.notifications.create({ // Use options object directly
                 type: 'basic',
                 iconUrl: iconUrl,
                 title: title,
                 message: message,
                 priority: 0 // Default priority
             }, (notificationId) => {
                 // Callback checks for creation errors
                 if (chrome.runtime.lastError) {
                     log('warn', '[Actions] Could not create notification:', chrome.runtime.lastError.message);
                 } else {
                     // log('info', `[Actions] Notification sent: ${notificationId}`); // Reduced verbosity
                 }
             });
         } else {
             // log('info', '[Actions] Notification permission not granted. Skipping notification.'); // Reduced verbosity
             // Optionally show a status message in the popup as fallback
             // ui.showStatus("Tip: Grant Notification permission for alerts.", false);
         }
     } catch (notifyError) {
         // Catch errors from the permission check promise itself or unexpected issues
         log('warn', '[Actions] Error checking/sending notification:', notifyError);
     }
}

/**
 * Calculates the token count for the given text using the imported tokenizer.
 * Includes error handling and safety checks.
 * @param {string} text - The text content to tokenize.
 * @returns {number} The number of tokens, or 0 if error or empty text.
 */
function calculateAccurateTokenCount(text) {
    if (!text || typeof text !== 'string' || text.length === 0) {
        return 0;
    }

    // Safety check: Avoid tokenizing excessively large strings that might crash the browser/tab
    if (text.length > MAX_TOKENIZER_CHARS) {
        log('warn', `[Actions] Text content length (${text.length}) exceeds safety limit (${MAX_TOKENIZER_CHARS}) for tokenization. Skipping token count.`);
        return -1; // Indicate skipped due to size limit
    }

    try {
        const tokens = encode(text); // Use the imported tokenizer function
        return tokens.length;
    } catch (error) {
        log('error', "[Actions] Error during token calculation:", error);
        // Decide how to handle tokenizer errors. Return 0 or a specific error indicator?
        // Returning 0 might be misleading. Let's return -1 for errors too.
        return -1; // Indicate error during tokenization
    }
}

// --- Action Handlers (called by event listeners set up in init) ---

/** Handles the click on the "Copy Context" button. */
async function handleCopyClick() {
    // log('info', "[Actions] Copy button clicked."); // Reduced verbosity

    // Get current state via callbacks
    const repoInfo = getRepoInfo ? getRepoInfo() : null;
    const selectionState = getSelectionState ? getSelectionState() : {};
    const fileTreeData = getFileTreeData ? getFileTreeData() : [];

    if (!repoInfo || !repoInfo.owner || !repoInfo.repo) {
        log('error', "[Actions] Cannot copy: Missing repository information.");
        ui.showError("Repository information is missing. Please refresh.");
        return;
    }

    const { owner, repo } = repoInfo;

    // Update UI to busy state
    ui.setCopyButtonBusy(true);
    ui.setRefreshDisabled(true);
    ui.clearMessages();
    ui.showStatus("Preparing context...");
    const startTime = performance.now();

    try {
        // 1. Fetch the prefix
        const contextPrefix = await getContextPrefix();
        // Continue even if prefix fetch failed (it returns "" and shows error via ui.showError)

        // 2. Identify selected files
        ui.showStatus("Identifying selected files...");
        const selectedFilesToFetch = [];
        for (const pathKey in selectionState) {
            if (selectionState[pathKey] === true && !pathKey.endsWith('/')) {
                const fileData = fileTreeData.find(item => item?.path === pathKey && item?.type === 'blob');
                if (fileData?.sha) {
                    selectedFilesToFetch.push({ path: fileData.path, sha: fileData.sha });
                } else {
                    log('warn', `[Actions] Could not find SHA for selected file: ${pathKey}. Skipping.`);
                }
            }
        }

        // log('info', `[Actions] Found ${selectedFilesToFetch.length} selected files with SHAs.`); // Reduced verbosity

        if (selectedFilesToFetch.length === 0) {
            ui.showError("No files selected to copy.");
            throw new Error("No files selected."); // Use error for control flow to finally block
        }

        // 3. Fetch file contents concurrently
        let filesProcessed = 0;
        let fetchErrors = 0;
        const totalToFetch = selectedFilesToFetch.length;
        ui.showStatus(`Fetching content for ${totalToFetch} files... (0/${totalToFetch})`);

        selectedFilesToFetch.sort((a, b) => a.path.localeCompare(b.path));

        const contentPromises = selectedFilesToFetch.map(file =>
            getFileContentBySha(owner, repo, file.sha)
                .then(content => {
                    filesProcessed++;
                    if (filesProcessed % 10 === 0 || filesProcessed === totalToFetch) { // Update status less frequently
                        ui.showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    return { path: file.path, content: content, error: null };
                })
                .catch(error => {
                    log('error', `[Actions] Failed to fetch content for ${file.path} (SHA: ${file.sha}):`, error);
                    fetchErrors++;
                    filesProcessed++;
                     if (filesProcessed % 10 === 0 || filesProcessed === totalToFetch) {
                        ui.showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    return { path: file.path, content: null, error: error.message || "Unknown fetch error" };
                })
        );

        const results = await Promise.all(contentPromises);
        const fetchEndTime = performance.now();
        log('info', `[Actions] Content fetching completed in ${((fetchEndTime - startTime) / 1000).toFixed(2)}s. Errors: ${fetchErrors}`);

        // 4. Format the context and Prepare for Tokenization
        ui.showStatus("Formatting context...");
        let formattedContext = contextPrefix;
        let contentForTokenization = contextPrefix; // Start with prefix for accurate count

        results.forEach(result => {
            if (result.content !== null) { // Check for non-error results
                // Sanitize null bytes before formatting or tokenization
                const sanitizedContent = result.content.replace(/\0/g, '');
                const fileBlock = `--- File: ${result.path} ---\n${sanitizedContent}\n\n`;
                formattedContext += fileBlock;
                contentForTokenization += fileBlock; // Append the same block for tokenization
            } else {
                 log('warn', `[Actions] Skipping file in final output due to fetch error: ${result.path}`);
                 // Optionally add a note about the failed file:
                 // formattedContext += `--- Error fetching file: ${result.path} ---\nError: ${result.error}\n\n`;
                 // Do *not* add error message to contentForTokenization
            }
        });

        // Remove trailing whitespace/newlines from the final *formatted* string
        formattedContext = formattedContext.trimEnd();
        // contentForTokenization remains untrimmed at the end for consistency if needed

        // 5. Calculate Accurate Token Count
        ui.showStatus("Calculating token count...");
        const actualTokenCount = calculateAccurateTokenCount(contentForTokenization);
        const tokenCountStr = actualTokenCount >= 0
            ? ` (${actualTokenCount.toLocaleString()} tokens)`
            : " (token count unavailable)"; // Handle -1 return values

        // 6. Copy to clipboard and provide feedback
        const filesCopiedCount = totalToFetch - fetchErrors;
        let finalMessage;
        let messageIsWarning = fetchErrors > 0;

        if (filesCopiedCount > 0 && formattedContext) {
            finalMessage = `Context for ${filesCopiedCount} file(s)${tokenCountStr} copied!`;
            if (fetchErrors > 0) {
                finalMessage += ` (${fetchErrors} failed)`;
            }
            await navigator.clipboard.writeText(formattedContext);
            log('info', `[Actions] Formatted context copied to clipboard. Files: ${filesCopiedCount}, Errors: ${fetchErrors}, Tokens: ${actualTokenCount >= 0 ? actualTokenCount : 'N/A'}`);
            ui.showStatus(finalMessage, messageIsWarning);
            notifyUser('GitHub AI Context Builder', finalMessage);

        } else if (filesCopiedCount === 0) { // No files copied successfully
             finalMessage = `Copy failed: Could not retrieve content for any of the ${fetchErrors} selected file(s).`;
             log('warn', `[Actions] Copy failed: No content retrieved. Errors: ${fetchErrors}`);
             ui.showError(finalMessage);
             notifyUser('GitHub AI Context Builder', finalMessage);
        } else { // Files copied, but formatted context ended up empty (e.g., prefix empty, all files empty)
             finalMessage = `Copy failed: Generated context is empty, though ${filesCopiedCount} file(s) were processed.`;
             if (fetchErrors > 0) finalMessage += ` (${fetchErrors} failed)`;
             log('warn', `[Actions] Copy failed: Formatted context is empty. Files processed: ${filesCopiedCount}, Errors: ${fetchErrors}`);
             ui.showError(finalMessage);
        }

    } catch (error) {
        // Catch errors from setup phase or Promise.all/tokenization itself
        log('error', "[Actions] Error during copy process:", error);
        // Avoid double message for the "No files selected" case
        if (error.message !== "No files selected.") {
             ui.showError(`Copy failed: ${error.message}`);
        }
    } finally {
        // Restore UI state regardless of success or failure
        ui.setCopyButtonBusy(false);
        // Allow the main module/state handler to re-evaluate button states based on current selection
        ui.setRefreshDisabled(false); // Explicitly re-enable refresh
        // It's crucial that the caller (popup.js/state.js) logic eventually calls ui.updateControlsState()
        // This happens implicitly via handleTreeStateUpdate in the current flow, which should be sufficient.
        const endTime = performance.now();
        log('info', `[Actions] Total copy operation took ${((endTime - startTime) / 1000).toFixed(2)}s.`);
    }
}

/** Handles the click on the "Refresh" button. */
function handleRefreshClick() {
    // log('info', "[Actions] Refresh button clicked."); // Reduced verbosity
    ui.clearMessages();
    ui.updateRepoTitle("Refreshing...");
    ui.setControlsDisabled();
    ui.setRefreshDisabled(true);

    if (triggerRefresh) {
        triggerRefresh();
    } else {
        log('error', "[Actions] Cannot refresh: Trigger refresh callback not configured.");
        ui.showError("Refresh action is not configured.");
        ui.setRefreshDisabled(false);
    }
}

// --- Public Initialization Function ---

/**
 * Initializes the actions module.
 * Stores callbacks and attaches listeners to action buttons.
 * @param {object} config - Configuration object.
 * @param {HTMLElement} config.copyButtonElement - The copy button DOM element.
 * @param {HTMLElement} config.refreshButtonElement - The refresh button DOM element.
 * @param {Function} config.getRepoInfoCallback - Function returning { owner, repo, ref, ... }.
 * @param {Function} config.getSelectionStateCallback - Function returning the selectionState object.
 * @param {Function} config.getFileTreeDataCallback - Function returning the fileTreeData array.
 * @param {Function} config.triggerRefreshCallback - Function to call when refresh is requested.
 */
function initActions(config) {
    // log('info', "[Actions] Initializing..."); // Reduced verbosity
    if (!config || !config.copyButtonElement || !config.refreshButtonElement ||
        typeof config.getRepoInfoCallback !== 'function' ||
        typeof config.getSelectionStateCallback !== 'function' ||
        typeof config.getFileTreeDataCallback !== 'function' ||
        typeof config.triggerRefreshCallback !== 'function')
    {
        log('error', "[Actions] Initialization failed: Invalid configuration provided.", config);
        throw new Error("Actions module initialization failed due to missing or invalid configuration.");
    }

    // Store callbacks
    getRepoInfo = config.getRepoInfoCallback;
    getSelectionState = config.getSelectionStateCallback;
    getFileTreeData = config.getFileTreeDataCallback;
    triggerRefresh = config.triggerRefreshCallback;

    // Remove potentially existing listeners before adding new ones
    config.copyButtonElement.removeEventListener('click', handleCopyClick);
    config.refreshButtonElement.removeEventListener('click', handleRefreshClick);

    // Attach listeners
    config.copyButtonElement.addEventListener('click', handleCopyClick);
    config.refreshButtonElement.addEventListener('click', handleRefreshClick);

    // log('info', "[Actions] Event listeners attached."); // Reduced verbosity
}

export {
    initActions
};

// console.log("[Popup Actions] Module loaded."); // Removed module load noise