// File: popup/popup_state.js
// Import getItemPathKey along with other utils
import { log, formatBytes, getItemPathKey } from './popup_utils.js';
import { getRepoSelectionState, setRepoSelectionState } from '../common/storage.js';
// Import the specific UI functions needed
import { updateSelectionInfo, updateTokenEstimate, updateControlsState } from './popup_ui.js';

// console.log("[Popup State] Module loading...");

// --- State Variables ---
let selectionState = {};   // Tracks selection state { [pathKey]: boolean }
let fileTreeData = [];     // Reference to file tree data from repository module
let totalSelectedFiles = 0;
let totalSelectedSize = 0;
let currentRepoUrl = null; // Used for persistence key

// --- Configuration ---
const BYTES_PER_TOKEN_ESTIMATE = 4; // Heuristic for estimation

// --- Callback ---
let onStateUpdateCallback = null; // Optional: For coordinator if needed

// --- Public API ---

/**
 * Initializes the state module with required references and initial data.
 * @param {object} config - Configuration object
 * @param {Array<object>} config.fileTreeDataRef - Reference to file tree data array
 * @param {string} config.repoUrl - Current repository URL
 * @param {Function} config.onStateUpdateCallback - Function to call when state changes (optional)
 */
function initState(config) {
    // log('info', "[Popup State] Initializing state module...");

    if (!config || !Array.isArray(config.fileTreeDataRef) || !config.repoUrl) {
        log('error', "[Popup State] Invalid initialization config:", config);
        throw new Error("State module initialization failed: Invalid configuration");
    }

    fileTreeData = config.fileTreeDataRef; // Store reference
    currentRepoUrl = config.repoUrl;
    if (typeof config.onStateUpdateCallback === 'function') {
        onStateUpdateCallback = config.onStateUpdateCallback;
    }

    // Reset state to start fresh
    resetState();

    // log('info', "[Popup State] State module initialized");
    return { selectionState }; // Return reference to the state object
}

/**
 * Resets the state variables to their defaults.
 */
function resetState() {
    // log('info', '[Popup State] Resetting internal state.');
    selectionState = {}; // Create a new object
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
}

/**
 * Loads saved selection state from storage or defaults based on current tree.
 * Updates the internal selection state object and returns a reference to it.
 * @returns {Promise<object>} - Promise resolving to the selection state object reference
 */
async function loadAndApplySelectionState() {
    // log('info', "[Popup State] Loading selection state...");

    if (!currentRepoUrl) {
        log('error', "[Popup State] Cannot load state: repository URL not set");
        return selectionState;
    }

    let persistedState = null;
    try {
        persistedState = await getRepoSelectionState(currentRepoUrl);
    } catch (error) {
        log('error', "[Popup State] Error loading persisted state from storage:", error);
    }

    selectionState = {}; // Start fresh for application

    // Get current keys from file tree data
    const currentKeys = new Set(fileTreeData.map(item =>
        item?.path ? getItemPathKey(item) : null // Use util, handle potential invalid items
    ).filter(Boolean));

    if (persistedState && typeof persistedState === 'object') {
        // log('info', "[Popup State] Applying persisted selection state");

        for (const key in persistedState) {
            if (currentKeys.has(key)) {
                selectionState[key] = !!persistedState[key]; // Ensure boolean
            }
        }

        currentKeys.forEach(key => {
            if (!(key in selectionState)) {
                selectionState[key] = true; // Default new items to selected
            }
        });
    } else {
        // log('info', "[Popup State] No valid persisted state found, defaulting all to selected");
        currentKeys.forEach(key => {
            selectionState[key] = true;
        });
    }

    // Calculate initial totals and update UI immediately after loading
    handleTreeStateUpdate(); // Trigger UI update based on loaded state

    return selectionState; // Return reference
}

/**
 * Calculates the total number, size, and estimated tokens of selected files.
 * Updates the internal totalSelectedFiles and totalSelectedSize variables.
 * @returns {{count: number, size: number, formattedSize: string, estimatedTokens: number}} Metrics object
 */
function calculateSelectedTotals() {
    let count = 0;
    let size = 0;

    if (!Array.isArray(fileTreeData)) {
        log('warn', '[Popup State] Cannot calculate totals: fileTreeData is not available or not an array.');
        return { count: 0, size: 0, formattedSize: '0 B', estimatedTokens: 0 };
    }

    for (const pathKey in selectionState) {
        if (selectionState[pathKey] === true && !pathKey.endsWith('/')) {
            const fileData = fileTreeData.find(item =>
                item?.path === pathKey && item?.type === 'blob'
            );

            if (fileData && typeof fileData.size === 'number') {
                count++;
                size += fileData.size;
            } else if (fileData) {
                log('warn', `[Popup State] File data found for ${pathKey} but size is missing or invalid:`, fileData.size);
            }
        }
    }

    totalSelectedFiles = count;
    totalSelectedSize = size;

    const estimatedTokens = Math.round(totalSelectedSize / BYTES_PER_TOKEN_ESTIMATE);

    return {
        count: totalSelectedFiles,
        size: totalSelectedSize,
        formattedSize: formatBytes(totalSelectedSize),
        estimatedTokens: estimatedTokens
    };
}


/**
 * Called when the selection state changes (e.g., via tree logic).
 * Recalculates totals, updates UI elements (count, size, tokens, button states),
 * and triggers the optional external callback.
 */
function handleTreeStateUpdate() {
    // log('log', '[Popup State] Handling state update...');

    const { count, formattedSize, estimatedTokens } = calculateSelectedTotals();

    updateSelectionInfo(count, formattedSize);
    updateTokenEstimate(estimatedTokens);

    const hasItems = fileTreeData && fileTreeData.length > 0;
    const hasSelection = count > 0;
    updateControlsState(hasItems, hasSelection);

    if (onStateUpdateCallback) {
        onStateUpdateCallback({
            hasItems,
            hasSelection,
            totalSelectedFiles: count,
            totalSelectedSize
        });
    }
}

/**
 * Persists the current selection state to storage.
 * @returns {Promise<boolean>} - Whether the save was successful
 */
async function saveSelectionState() {
    // log('log', "[Popup State] Saving selection state...");

    if (!currentRepoUrl) {
        log('error', "[Popup State] Cannot save state: repository URL not set");
        return false;
    }

    try {
        const stateToSave = { ...selectionState };
        const success = await setRepoSelectionState(currentRepoUrl, stateToSave);

        if (!success) {
            log('error', "[Popup State] Failed to persist selection state (setRepoSelectionState returned false).");
            return false;
        }
        // log('info', "[Popup State] Selection state persisted successfully.");
        return true;
    } catch (error) {
        log('error', "[Popup State] Exception during state persistence:", error);
        return false;
    }
}

/**
 * Gets current state information for actions module.
 * @returns {object} Current selection state (direct reference for efficiency)
 */
function getSelectionStateForActions() {
    return selectionState;
}

/**
 * Gets the current selection metrics (count, size, estimate).
 * @returns {object} Object with count, size, formattedSize, and estimatedTokens
 */
function getSelectionMetrics() {
    return {
        count: totalSelectedFiles,
        size: totalSelectedSize,
        formattedSize: formatBytes(totalSelectedSize),
        estimatedTokens: Math.round(totalSelectedSize / BYTES_PER_TOKEN_ESTIMATE)
    };
}

/**
 * Updates the repository URL used for state persistence key.
 * @param {string} repoUrl - The new repository URL
 */
function updateRepoUrl(repoUrl) {
    if (repoUrl && typeof repoUrl === 'string') {
        if (currentRepoUrl !== repoUrl) {
            // log('info', `[Popup State] Updating repository URL for persistence: ${repoUrl}`);
            currentRepoUrl = repoUrl;
        }
    } else {
        log('warn', '[Popup State] Attempted to update repo URL with invalid value:', repoUrl);
    }
}

export {
    initState,
    resetState,
    loadAndApplySelectionState,
    // calculateSelectedTotals, // Internal
    handleTreeStateUpdate, // Core update trigger
    saveSelectionState,
    getSelectionStateForActions, // For copy action
    getSelectionMetrics, // For potentially displaying metrics elsewhere
    updateRepoUrl // For coordinator to set on init/refresh
};

// console.log("[Popup State] Module loaded.");