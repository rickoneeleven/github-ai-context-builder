// File: popup/popup_ui.js
import { log } from './popup_utils.js'; // Assuming log is needed for potential UI errors

console.log("[Popup UI] Module loading...");

// --- Constants ---
// Unicode icons for buttons (consider centralizing if used elsewhere)
const REFRESH_ICON_BUSY = '\u21BB'; // Refresh symbol often used for 'in progress'
const COPY_ICON_DEFAULT = '\u{1F4CB}'; // Clipboard icon
const DEFAULT_LOAD_TIME_TEXT = "";

// --- DOM Elements Cache ---
let repoTitleElement = null;
let copyButton = null;
let refreshButton = null;
let statusMessageElement = null;
let errorMessageElement = null;
let expandAllButton = null;
let collapseAllButton = null;
let selectedCountElement = null;
let selectedSizeElement = null;
let fileTreeContainer = null; // Needed to check if tree has items
let perfStatsElement = null;

// Store original button text/HTML to restore later
let originalCopyButtonHTML = '';

/**
 * Initializes the UI module by caching DOM element references.
 * Should be called once when the popup loads.
 */
function initUI() {
    log('info', "[Popup UI] Initializing UI element references...");
    repoTitleElement = document.getElementById('repo-title');
    copyButton = document.getElementById('copy-button');
    refreshButton = document.getElementById('refresh-button');
    statusMessageElement = document.getElementById('status-message');
    errorMessageElement = document.getElementById('error-message');
    expandAllButton = document.getElementById('expand-all');
    collapseAllButton = document.getElementById('collapse-all');
    selectedCountElement = document.getElementById('selected-count');
    selectedSizeElement = document.getElementById('selected-size');
    fileTreeContainer = document.getElementById('file-tree-container'); // Assume exists
    perfStatsElement = document.getElementById('perf-stats');

    if (copyButton) {
        // Store the initial HTML, assuming it includes the default icon
        originalCopyButtonHTML = copyButton.innerHTML;
        // Set default icon explicitly if needed
         const iconElement = copyButton.querySelector('.icon');
         if (iconElement) iconElement.textContent = COPY_ICON_DEFAULT;
    } else {
        log('warn', "[Popup UI] Copy button not found during init.");
    }

     // Set initial performance stats text
     if (perfStatsElement) {
         perfStatsElement.textContent = DEFAULT_LOAD_TIME_TEXT;
     }

    log('info', "[Popup UI] UI element references initialized.");
}

// --- Message Display Functions ---

/**
 * Displays a status message to the user. Clears error message.
 * @param {string} message The message to display.
 * @param {boolean} [isWarning=false] If true, uses warning styling.
 */
function showStatus(message, isWarning = false) {
    if (!statusMessageElement || !errorMessageElement) {
        log('warn', "[Popup UI] Status/Error element not found for message:", message);
        return;
    }
    log('info', `[Popup UI] Status: ${message} ${isWarning ? '(Warning)' : ''}`);
    errorMessageElement.classList.add('hidden');
    errorMessageElement.textContent = '';
    statusMessageElement.textContent = message;
    statusMessageElement.classList.remove('hidden');
    // Ensure correct classes are applied
    statusMessageElement.classList.toggle('error', isWarning); // Use 'error' class for warning style
    statusMessageElement.classList.toggle('status', !isWarning); // Use 'status' class for normal status
}

/**
 * Displays an error message to the user. Clears status message.
 * @param {string} message The error message to display.
 */
function showError(message) {
    if (!statusMessageElement || !errorMessageElement) {
         log('warn', "[Popup UI] Status/Error element not found for error message:", message);
         return;
    }
    log('error', `[Popup UI] Error displayed: ${message}`);
    statusMessageElement.classList.add('hidden');
    statusMessageElement.textContent = '';
    errorMessageElement.textContent = message;
    errorMessageElement.classList.remove('hidden');
    errorMessageElement.classList.add('error'); // Ensure error class is present
}

/** Clears any currently displayed status or error messages. */
function clearMessages() {
    if (statusMessageElement) {
        statusMessageElement.classList.add('hidden');
        statusMessageElement.textContent = '';
        statusMessageElement.classList.remove('error', 'status'); // Remove styling classes
    }
    if (errorMessageElement) {
        errorMessageElement.classList.add('hidden');
        errorMessageElement.textContent = '';
    }
}

// --- Header and Info Update Functions ---

/**
 * Updates the main repository title in the header.
 * @param {string} title - The text to display as the title.
 * @param {string} [tooltip=''] - Optional tooltip text for the title element.
 */
function updateRepoTitle(title, tooltip = '') {
    if (repoTitleElement) {
        repoTitleElement.textContent = title;
        repoTitleElement.title = tooltip || title; // Use title as tooltip if none provided
    } else {
         log('warn', "[Popup UI] Repo title element not found.");
    }
}

/**
 * Updates the display of selected file count and total size.
 * @param {number} count - The number of selected files.
 * @param {string} formattedSize - The human-readable formatted size string (e.g., "1.2 MB").
 */
function updateSelectionInfo(count, formattedSize) {
    if (selectedCountElement) {
        selectedCountElement.textContent = `Selected: ${count} file${count !== 1 ? 's' : ''}`;
    } else {
         log('warn', "[Popup UI] Selected count element not found.");
    }
    if (selectedSizeElement) {
        selectedSizeElement.textContent = `Total Size: ${formattedSize}`;
    } else {
         log('warn', "[Popup UI] Selected size element not found.");
    }
    // Note: Enabling/disabling copy button is handled by updateControlsState
}

/**
 * Updates the performance stats display in the footer.
 * @param {string} text - The text to display (e.g., "Load time: 1.23s").
 */
function updatePerformanceStats(text) {
    if (perfStatsElement) {
        perfStatsElement.textContent = text || DEFAULT_LOAD_TIME_TEXT;
    } else {
        log('warn', "[Popup UI] Performance stats element not found.");
    }
}

// --- Control Button State Functions ---

/**
 * Sets the initial disabled state for all controls (typically called on init or error).
 */
function setControlsDisabled() {
    log('info', "[Popup UI] Disabling all controls.");
    if (copyButton) copyButton.disabled = true;
    if (expandAllButton) expandAllButton.disabled = true;
    if (collapseAllButton) collapseAllButton.disabled = true;
    // Keep Refresh enabled unless explicitly disabled elsewhere
    if (refreshButton) refreshButton.disabled = false; // Default assumption
}

/**
 * Sets the disabled state for the Refresh button specifically.
 * @param {boolean} disabled - True to disable, false to enable.
 */
function setRefreshDisabled(disabled) {
     if (refreshButton) {
         refreshButton.disabled = disabled;
     } else {
         log('warn', "[Popup UI] Refresh button not found.");
     }
}


/**
 * Updates the enabled/disabled state of controls based on current application state.
 * @param {boolean} hasItems - Whether the file tree has any items rendered.
 * @param {boolean} hasSelection - Whether any files are currently selected.
 */
function updateControlsState(hasItems, hasSelection) {
    log('info', `[Popup UI] Updating controls state. hasItems: ${hasItems}, hasSelection: ${hasSelection}`);
    if (copyButton) {
        copyButton.disabled = !hasSelection; // Enable copy only if something is selected
    }
    if (expandAllButton) {
        expandAllButton.disabled = !hasItems; // Enable expand/collapse only if tree has items
    }
    if (collapseAllButton) {
        collapseAllButton.disabled = !hasItems;
    }
    if (refreshButton) {
        refreshButton.disabled = false; // Always enable refresh when state is updated (unless mid-operation)
    }
}

/**
 * Updates the visual state of the Copy button (e.g., during the copy process).
 * @param {boolean} isBusy - True if the copy operation is in progress.
 */
function setCopyButtonBusy(isBusy) {
    if (!copyButton) {
        log('warn', "[Popup UI] Copy button not found.");
        return;
    }
    if (isBusy) {
        copyButton.disabled = true; // Ensure it's disabled while busy
        copyButton.innerHTML = `<span class="icon">${REFRESH_ICON_BUSY}</span> Copying...`;
    } else {
        // Restore original content and let updateControlsState handle disabling based on selection
        copyButton.innerHTML = originalCopyButtonHTML;
        // Re-enablement depends on selection state, caller should call updateControlsState after setting busy=false
    }
}

export {
    initUI,
    showStatus,
    showError,
    clearMessages,
    updateRepoTitle,
    updateSelectionInfo,
    updatePerformanceStats,
    setControlsDisabled,
    setRefreshDisabled,
    updateControlsState,
    setCopyButtonBusy
};

console.log("[Popup UI] Module loaded.");