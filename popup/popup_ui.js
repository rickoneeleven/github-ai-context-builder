// File: popup/popup_ui.js
import { log } from './popup_utils.js'; // log is primarily for errors/warnings now

// --- Constants ---
const REFRESH_ICON_BUSY = '🔄'; // Unicode refresh symbol
const COPY_ICON_DEFAULT = '📋'; // Unicode clipboard symbol
const DEFAULT_LOAD_TIME_TEXT = "";
const DEFAULT_BRANCH_TEXT = "default branch";

// --- DOM Elements Cache ---
let repoTitleElement = null;
let repoBranchElement = null;
let copyButton = null;
let refreshButton = null;
let statusMessageElement = null;
let errorMessageElement = null;
let expandAllButton = null;
let collapseAllButton = null;
let selectedCountElement = null;
// Removed: selectedSizeElement = null;
// Removed: selectedTokensElement = null;
let selectedSizeFooterElement = null; // Added for footer
let selectedTokensFooterElement = null; // Added for footer
let fileTreeContainer = null;
let perfStatsElement = null;

// Store original button text/HTML to restore later
let originalCopyButtonHTML = '';

/**
 * Initializes the UI module by caching DOM element references.
 */
function initUI() {
    repoTitleElement = document.getElementById('repo-title');
    repoBranchElement = document.getElementById('repo-branch');
    copyButton = document.getElementById('copy-button');
    refreshButton = document.getElementById('refresh-button');
    statusMessageElement = document.getElementById('status-message');
    errorMessageElement = document.getElementById('error-message');
    expandAllButton = document.getElementById('expand-all');
    collapseAllButton = document.getElementById('collapse-all');
    selectedCountElement = document.getElementById('selected-count');
    // Added: cache new footer elements
    selectedSizeFooterElement = document.getElementById('selected-size-footer');
    selectedTokensFooterElement = document.getElementById('selected-tokens-footer');
    fileTreeContainer = document.getElementById('file-tree-container');
    perfStatsElement = document.getElementById('perf-stats');

    if (copyButton) {
        originalCopyButtonHTML = copyButton.innerHTML;
        const iconElement = copyButton.querySelector('.icon');
        if (iconElement) iconElement.textContent = COPY_ICON_DEFAULT;
    } else {
        log('warn', "[Popup UI] Copy button not found during init.");
    }

    if (perfStatsElement) {
        perfStatsElement.textContent = DEFAULT_LOAD_TIME_TEXT;
    }

    if (!repoBranchElement) {
        log('warn', "[Popup UI] Repo branch element not found during init.");
    }

    // Updated checks for new footer elements
    if (!selectedSizeFooterElement) {
        log('warn', "[Popup UI] Selected size footer element not found during init.");
    }
    if (!selectedTokensFooterElement) {
        log('warn', "[Popup UI] Selected tokens footer element not found during init.");
    }
}

// --- Message Display Functions ---

/**
 * Displays a status message. Clears error message.
 * @param {string} message The message to display.
 * @param {boolean} [isWarning=false] If true, uses warning styling.
 */
function showStatus(message, isWarning = false) {
    if (!statusMessageElement || !errorMessageElement) {
        log('warn', "[Popup UI] Status/Error element not found for message:", message);
        return;
    }
    errorMessageElement.classList.add('hidden');
    errorMessageElement.textContent = '';
    statusMessageElement.textContent = message;
    statusMessageElement.classList.remove('hidden');
    statusMessageElement.classList.toggle('error', isWarning);
    statusMessageElement.classList.toggle('status', !isWarning);
}

/**
 * Displays an error message. Clears status message.
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
    errorMessageElement.classList.add('error');
}

/**
 * Displays a user-friendly error message (e.g., not on GitHub).
 * @param {string} title - The main error title.
 * @param {string} description - More detailed explanation.
 */
function showFriendlyError(title, description) {
    if (!statusMessageElement || !errorMessageElement) {
        log('warn', "[Popup UI] Status/Error element not found for friendly error message");
        return;
    }
    log('info', `[Popup UI] Friendly error displayed: ${title} - ${description}`);
    statusMessageElement.classList.add('hidden');
    statusMessageElement.textContent = '';

    errorMessageElement.innerHTML = `
        <strong>${title}</strong>
        <p>${description}</p>
    `;
    errorMessageElement.classList.remove('hidden');
    errorMessageElement.classList.add('error');

    if (fileTreeContainer) {
        fileTreeContainer.innerHTML = '';
    }
    setControlsDisabled();
    setRefreshDisabled(false);
    updateRepoBranch(null);
}

/** Clears status or error messages. */
function clearMessages() {
    if (statusMessageElement) {
        statusMessageElement.classList.add('hidden');
        statusMessageElement.textContent = '';
        statusMessageElement.classList.remove('error', 'status');
    }
    if (errorMessageElement) {
        errorMessageElement.classList.add('hidden');
        errorMessageElement.textContent = '';
    }
}

// --- Header and Info Update Functions ---

/**
 * Updates the main repository title (owner/repo part).
 * @param {string} title - Text for the title (e.g., "owner/repo").
 * @param {string} [tooltip=''] - Optional tooltip text.
 */
function updateRepoTitle(title, tooltip = '') {
    if (repoTitleElement) {
        const textNode = repoTitleElement.childNodes[0];
        if (textNode && textNode.nodeType === Node.TEXT_NODE) {
            textNode.textContent = title + ' ';
        } else {
            repoTitleElement.textContent = title + ' ';
            log('warn', "[Popup UI] Repo title structure unexpected, resetting textContent.");
            if (repoBranchElement && !repoTitleElement.contains(repoBranchElement)) {
                repoTitleElement.appendChild(repoBranchElement);
            }
        }
        repoTitleElement.title = tooltip || title;
    } else {
         log('warn', "[Popup UI] Repo title element not found.");
    }
}

/**
 * Updates the branch/ref display in the header.
 * @param {string | null} refName - The branch/tag/SHA name, or null/undefined for default.
 */
function updateRepoBranch(refName) {
    if (repoBranchElement) {
        if (refName && typeof refName === 'string') {
            repoBranchElement.textContent = refName;
            repoBranchElement.title = `Current ref: ${refName}`;
            repoBranchElement.classList.remove('hidden');
        } else {
            repoBranchElement.textContent = DEFAULT_BRANCH_TEXT;
            repoBranchElement.title = 'Default repository branch';
            repoBranchElement.classList.remove('hidden');
        }
    } else {
        log('warn', "[Popup UI] Repo branch element not found.");
    }
}


/**
 * Updates selected file count (in controls) and total size (in footer).
 * @param {number} count - Number of selected files.
 * @param {string} formattedSize - Human-readable size string for the footer.
 */
function updateSelectionInfo(count, formattedSize) {
    if (selectedCountElement) {
        selectedCountElement.textContent = `Selected: ${count} file${count !== 1 ? 's' : ''}`;
    }
    // Updated: Target the footer element for size
    if (selectedSizeFooterElement) {
        selectedSizeFooterElement.textContent = `Total Size: ${formattedSize}`;
    } else {
        log('warn', "[Popup UI] Selected size footer element not found for update.");
    }
}

/**
 * Updates the estimated token count display in the footer.
 * @param {number} estimatedTokens - The calculated estimate.
 */
function updateTokenEstimate(estimatedTokens) {
    // Updated: Target the footer element for tokens
    if (selectedTokensFooterElement) {
        const displayTokens = estimatedTokens >= 1000
            ? `${(estimatedTokens / 1000).toFixed(1)}k`
            : estimatedTokens;
        selectedTokensFooterElement.textContent = `Est. Tokens: ~${displayTokens}`;
    } else {
        log('warn', "[Popup UI] Selected tokens footer element not found for update.");
    }
}

/**
 * Updates performance stats display.
 * @param {string} text - Text to display (e.g., "Load time: 1.23s").
 */
function updatePerformanceStats(text) {
    if (perfStatsElement) {
        perfStatsElement.textContent = text || DEFAULT_LOAD_TIME_TEXT;
    }
}

// --- Control Button State Functions ---

/** Sets initial disabled state for controls. */
function setControlsDisabled() {
    if (copyButton) copyButton.disabled = true;
    if (expandAllButton) expandAllButton.disabled = true;
    if (collapseAllButton) collapseAllButton.disabled = true;
    if (refreshButton) refreshButton.disabled = false;
}

/**
 * Sets disabled state for Refresh button.
 * @param {boolean} disabled - True to disable, false to enable.
 */
function setRefreshDisabled(disabled) {
     if (refreshButton) {
         refreshButton.disabled = disabled;
     }
}


/**
 * Updates enabled/disabled state of controls based on application state.
 * @param {boolean} hasItems - Whether file tree has items.
 * @param {boolean} hasSelection - Whether files are selected.
 */
function updateControlsState(hasItems, hasSelection) {
    if (copyButton) {
        const isBusy = copyButton.dataset.busy === 'true';
        copyButton.disabled = isBusy || !hasSelection;
    }
    if (expandAllButton) {
        expandAllButton.disabled = !hasItems;
    }
    if (collapseAllButton) {
        collapseAllButton.disabled = !hasItems;
    }
    if (refreshButton) {
        const isCopyBusy = copyButton?.dataset?.busy === 'true';
        if (!isCopyBusy) refreshButton.disabled = false;
    }
}

/**
 * Updates visual state of Copy button during operation.
 * @param {boolean} isBusy - True if copy operation is in progress.
 */
function setCopyButtonBusy(isBusy) {
    if (!copyButton) {
        log('warn', "[Popup UI] Copy button not found.");
        return;
    }
    copyButton.dataset.busy = isBusy ? 'true' : 'false';

    if (isBusy) {
        copyButton.disabled = true;
        copyButton.innerHTML = `<span class="icon">${REFRESH_ICON_BUSY}</span> Copying...`;
    } else {
        copyButton.innerHTML = originalCopyButtonHTML;
        const iconElement = copyButton.querySelector('.icon');
        if (iconElement) iconElement.textContent = COPY_ICON_DEFAULT;
    }
}

export {
    initUI,
    showStatus,
    showError,
    showFriendlyError,
    clearMessages,
    updateRepoTitle,
    updateRepoBranch,
    updateSelectionInfo, // Updates count (controls) and size (footer)
    updateTokenEstimate, // Updates tokens (footer)
    updatePerformanceStats,
    setControlsDisabled,
    setRefreshDisabled,
    updateControlsState,
    setCopyButtonBusy
};