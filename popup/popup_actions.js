// File: popup/actions.js
import { log } from './popup_utils.js';
import * as ui from './popup_ui.js'; // Import all UI functions for easy access
import { getFileContentBySha } from '../common/github_api.js';

console.log("[Popup Actions] Module loading...");

// --- Constants ---
const CONTEXT_PREFIX_PATH = 'assets/context_prefix.txt';

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
        log('info', `[Actions] Fetching context prefix from: ${prefixUrl}`);
        const response = await fetch(prefixUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch prefix: ${response.status} ${response.statusText}`);
        }
        const prefixText = await response.text();
        log('info', "[Actions] Successfully fetched context prefix.");
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
 * Requires 'notifications' permission in manifest.json.
 * @param {string} title - Notification title.
 * @param {string} message - Notification message.
 */
async function notifyUser(title, message) {
    if (!chrome.notifications) {
        log('warn', '[Actions] Notifications API not available.');
        return;
    }
     try {
        // Check permission (basic check, might need request in a real app)
        const hasPermission = await new Promise((resolve) => {
             if (chrome.permissions?.contains) {
                 chrome.permissions.contains({ permissions: ['notifications'] }, resolve);
             } else {
                 resolve(true); // Assume permission if API exists but cannot check
                 log('warn', '[Actions] Cannot verify notification permission via Permissions API.');
             }
        });


         if (hasPermission) {
              const iconUrl = chrome.runtime.getURL('icons/icon48.png'); // Ensure this icon exists
              chrome.notifications.create({
                 type: 'basic',
                 iconUrl: iconUrl,
                 title: title,
                 message: message
             }, (notificationId) => {
                 if (chrome.runtime.lastError) {
                     log('warn', '[Actions] Could not create notification:', chrome.runtime.lastError.message);
                 } else {
                     log('info', `[Actions] Notification sent: ${notificationId}`);
                 }
             });
         } else {
             log('info', '[Actions] Notification permission not granted. Skipping notification.');
             // Optionally show a status message in the popup as fallback
             // ui.showStatus("Notification permission needed for alerts.", true);
         }
     } catch (notifyError) {
         log('warn', '[Actions] Error checking/sending notification:', notifyError);
     }
}

// --- Action Handlers (called by event listeners set up in init) ---

/** Handles the click on the "Copy Context" button. */
async function handleCopyClick() {
    log('info', "[Actions] Copy button clicked.");

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
    ui.setRefreshDisabled(true); // Disable refresh during copy
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
            // Only include files (not folders ending with '/') that are checked (true)
            if (selectionState[pathKey] === true && !pathKey.endsWith('/')) {
                const fileData = fileTreeData.find(item => item.path === pathKey && item.type === 'blob');
                if (fileData && fileData.sha) {
                    selectedFilesToFetch.push({ path: fileData.path, sha: fileData.sha });
                } else {
                    log('warn', `[Actions] Could not find SHA for selected file: ${pathKey}. Skipping.`);
                }
            }
        }

        log('info', `[Actions] Found ${selectedFilesToFetch.length} selected files with SHAs.`);

        if (selectedFilesToFetch.length === 0) {
            ui.showError("No files selected to copy.");
            // No need to proceed further
            throw new Error("No files selected."); // Throw to break execution and reach finally block
        }

        // 3. Fetch file contents concurrently
        let filesProcessed = 0;
        let fetchErrors = 0;
        const totalToFetch = selectedFilesToFetch.length;
        ui.showStatus(`Fetching content for ${totalToFetch} files... (0/${totalToFetch})`);

        // Sort files alphabetically by path before fetching for consistent output order
        selectedFilesToFetch.sort((a, b) => a.path.localeCompare(b.path));

        const contentPromises = selectedFilesToFetch.map(file =>
            getFileContentBySha(owner, repo, file.sha)
                .then(content => {
                    filesProcessed++;
                    if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) { // Update status periodically
                        ui.showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    return { path: file.path, content: content, error: null };
                })
                .catch(error => {
                    log('error', `[Actions] Failed to fetch content for ${file.path} (SHA: ${file.sha}):`, error);
                    fetchErrors++;
                    filesProcessed++;
                    if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) {
                        ui.showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    // Add error info to the result for later reporting
                    return { path: file.path, content: null, error: error.message || "Unknown fetch error" };
                })
        );

        const results = await Promise.all(contentPromises);
        const fetchEndTime = performance.now();
        log('info', `[Actions] Content fetching completed in ${((fetchEndTime - startTime) / 1000).toFixed(2)}s. Errors: ${fetchErrors}`);

        // 4. Format the context
        ui.showStatus("Formatting context...");
        let formattedContext = contextPrefix; // Start with the prefix
        results.forEach(result => {
            if (result.content !== null) { // Check for non-error results
                // Sanitize null bytes which can cause issues with clipboard/display
                const sanitizedContent = result.content.replace(/\0/g, '');
                formattedContext += `--- File: ${result.path} ---\n`;
                formattedContext += `${sanitizedContent}\n\n`;
            } else {
                 log('warn', `[Actions] Skipping file in final output due to fetch error: ${result.path}`);
                 // Optionally add a note about the failed file in the context:
                 // formattedContext += `--- Error fetching file: ${result.path} ---\nError: ${result.error}\n\n`;
            }
        });

        // Remove trailing whitespace/newlines from the final string
        formattedContext = formattedContext.trimEnd();

        // 5. Copy to clipboard and provide feedback
        const filesCopiedCount = totalToFetch - fetchErrors;
        let finalMessage;
        let messageIsWarning = fetchErrors > 0; // Treat any error as a warning in the status

        if (filesCopiedCount > 0) {
            finalMessage = `Context for ${filesCopiedCount} file(s) copied!`;
            if (fetchErrors > 0) {
                finalMessage += ` (${fetchErrors} failed)`;
            }
            // Only attempt clipboard write if there's something potentially useful
            if (formattedContext) {
                 await navigator.clipboard.writeText(formattedContext);
                 log('info', "[Actions] Formatted context copied to clipboard.");
                 ui.showStatus(finalMessage, messageIsWarning);
                 notifyUser('GitHub AI Context Builder', finalMessage);
            } else {
                 // This might happen if prefix is empty and all files failed or were empty
                 log('warn', "[Actions] Nothing to copy to clipboard (formatted context is empty despite processing files).");
                 finalMessage = `Copy failed: Generated context is empty. ${fetchErrors} file(s) failed to load.`;
                 ui.showError(finalMessage);
            }

        } else { // No files copied successfully
             finalMessage = `Copy failed: Could not retrieve content for any of the ${fetchErrors} selected file(s).`;
             ui.showError(finalMessage);
             notifyUser('GitHub AI Context Builder', finalMessage); // Notify about complete failure
        }

    } catch (error) {
        // Catch errors from setup phase (e.g., "No files selected") or Promise.all itself
        log('error', "[Actions] Error during copy process:", error);
        if (error.message !== "No files selected.") { // Avoid double message for no selection
             ui.showError(`Copy failed: ${error.message}`);
        }
    } finally {
        // Restore UI state regardless of success or failure
        ui.setCopyButtonBusy(false);
        // Let the main module re-evaluate button states based on current selection/items
        // We need a way to trigger this. Maybe the refresh callback implies this?
        // For now, just enable refresh. Main logic should call updateControlsState.
        ui.setRefreshDisabled(false);
        const endTime = performance.now();
        log('info', `[Actions] Total copy operation took ${((endTime - startTime) / 1000).toFixed(2)}s.`);
        // It's crucial that the caller (popup.js) re-runs its logic to update button states
        // based on the final selection count after the copy action finishes.
    }
}

/** Handles the click on the "Refresh" button. */
function handleRefreshClick() {
    log('info', "[Actions] Refresh button clicked.");
    // Update UI immediately
    ui.clearMessages();
    ui.updateRepoTitle("Refreshing...");
    ui.setControlsDisabled(); // Disable most controls
    ui.setRefreshDisabled(true); // Specifically disable refresh now

    // Trigger the refresh action in the main module via callback
    if (triggerRefresh) {
        triggerRefresh();
    } else {
        log('error', "[Actions] Cannot refresh: Trigger refresh callback not configured.");
        ui.showError("Refresh action is not configured.");
        ui.setRefreshDisabled(false); // Re-enable if callback missing
    }
}

// --- Public Initialization Function ---

/**
 * Initializes the actions module.
 * Stores callbacks and attaches listeners to action buttons.
 * @param {object} config - Configuration object.
 * @param {HTMLElement} config.copyButtonElement - The copy button DOM element.
 * @param {HTMLElement} config.refreshButtonElement - The refresh button DOM element.
 * @param {Function} config.getRepoInfoCallback - Function that returns { owner, repo }.
 * @param {Function} config.getSelectionStateCallback - Function that returns the selectionState object.
 * @param {Function} config.getFileTreeDataCallback - Function that returns the fileTreeData array.
 * @param {Function} config.triggerRefreshCallback - Function to call when refresh is requested.
 */
function initActions(config) {
    log('info', "[Actions] Initializing...");
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

    log('info', "[Actions] Event listeners attached.");
}

export {
    initActions
};

console.log("[Popup Actions] Module loaded.");