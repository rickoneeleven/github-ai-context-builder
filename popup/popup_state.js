// File: popup/popup_state.js
import { log, formatBytes } from './popup_utils.js';
import { getRepoSelectionState, setRepoSelectionState } from '../common/storage.js';
import * as ui from './popup_ui.js';

console.log("[Popup State] Module loading...");

// --- State Variables ---
let selectionState = {};   // Tracks selection state of each file/folder
let fileTreeData = [];     // Reference to file tree data (owned by repository module)
let totalSelectedFiles = 0;
let totalSelectedSize = 0;
let currentRepoUrl = null; // Need this for persistence

// --- Public API ---

/**
 * Initializes the state module with required references and initial data.
 * @param {object} config - Configuration object
 * @param {Array<object>} config.fileTreeDataRef - Reference to file tree data array
 * @param {string} config.repoUrl - Current repository URL
 * @param {Function} config.onStateUpdateCallback - Function to call when state changes
 */
function initState(config) {
    log('info', "[Popup State] Initializing state module...");
    
    if (!config || !config.fileTreeDataRef || !config.repoUrl || typeof config.onStateUpdateCallback !== 'function') {
        log('error', "[Popup State] Invalid initialization config:", config);
        throw new Error("State module initialization failed: Invalid configuration");
    }
    
    fileTreeData = config.fileTreeDataRef; // Store reference to the same array
    currentRepoUrl = config.repoUrl;
    onStateUpdateCallback = config.onStateUpdateCallback;
    
    // Reset state to start fresh
    resetState();
    
    log('info', "[Popup State] State module initialized");
    return { selectionState }; // Return reference to the state object
}

/**
 * Resets the state variables to their defaults.
 */
function resetState() {
    log('info', '[Popup State] Resetting internal state.');
    selectionState = {}; // Create a new object
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
}

/**
 * Loads saved selection state from storage or defaults to all selected.
 * Updates the internal selection state object and returns a reference to it.
 * @returns {Promise<object>} - Promise resolving to the selection state object reference
 */
async function loadAndApplySelectionState() {
    log('info', "[Popup State] Loading selection state...");
    
    if (!currentRepoUrl) {
        log('error', "[Popup State] Cannot load state: repository URL not set");
        return selectionState;
    }
    
    const persistedState = await getRepoSelectionState(currentRepoUrl);
    selectionState = {}; // Start fresh

    // Get current keys from file tree data
    const currentKeys = new Set(fileTreeData.map(item => 
        item && item.path ? 
            (item.type === 'tree' ? `${item.path}/` : item.path) : 
            null
    ).filter(Boolean));

    if (persistedState) {
        log('info', "[Popup State] Applying persisted selection state");
        
        // Apply persisted values for existing files/folders
        for (const key in persistedState) {
            if (currentKeys.has(key)) {
                selectionState[key] = persistedState[key];
            } else {
                log('log', `[Popup State] Pruning stale key from loaded state: ${key}`);
            }
        }
        
        // Set defaults for new files/folders
        currentKeys.forEach(key => {
            if (selectionState[key] === undefined) {
                log('log', `[Popup State] Setting default 'true' for new/missing key: ${key}`);
                selectionState[key] = true; // Default new items to selected
            }
        });
    } else {
        log('info', "[Popup State] No persisted state found, defaulting to all selected");
        
        // Default all to selected
        currentKeys.forEach(key => {
            selectionState[key] = true;
        });
    }
    
    // Calculate initial totals
    calculateSelectedTotals();
    return selectionState;
}

/**
 * Calculates the total number and size of selected files.
 * Updates the global totalSelectedFiles and totalSelectedSize variables.
 */
function calculateSelectedTotals() {
    let count = 0;
    let size = 0;
    
    for (const pathKey in selectionState) {
        // Only count files (not folders) that are explicitly selected (true)
        if (selectionState[pathKey] === true && !pathKey.endsWith('/')) {
            const fileData = fileTreeData.find(item => 
                item && 
                item.path === pathKey && 
                item.type === 'blob'
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
    
    return { 
        count: totalSelectedFiles, 
        size: totalSelectedSize, 
        formattedSize: formatBytes(totalSelectedSize) 
    };
}

// --- Callback for state changes ---
let onStateUpdateCallback = null;

/**
 * Called when the selection state changes. Updates UI and triggers callback.
 */
function handleTreeStateUpdate() {
    log('log', '[Popup State] Handling state update...');
    
    // Recalculate selected totals
    const { count, formattedSize } = calculateSelectedTotals();
    
    // Update UI with new totals
    ui.updateSelectionInfo(count, formattedSize);
    
    // Determine button states based on selection
    const hasItems = fileTreeData.length > 0;
    const hasSelection = count > 0;
    ui.updateControlsState(hasItems, hasSelection);
    
    // Notify any parent component that registered for updates
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
    log('log', "[Popup State] Saving selection state...");
    
    if (!currentRepoUrl) {
        log('error', "[Popup State] Cannot save state: repository URL not set");
        return false;
    }
    
    try {
        const success = await setRepoSelectionState(currentRepoUrl, selectionState);
        
        if (!success) {
            log('error', "[Popup State] Failed to persist selection state");
            return false;
        }
        
        return true;
    } catch (error) {
        log('error', "[Popup State] Error persisting selection state:", error);
        return false;
    }
}

/**
 * Gets current state information for actions module.
 * @returns {object} Current selection state
 */
function getSelectionStateForActions() {
    return selectionState; // Return direct reference
}

/**
 * Gets the current selection metrics.
 * @returns {object} Object with count, size, and formatted size
 */
function getSelectionMetrics() {
    return {
        count: totalSelectedFiles,
        size: totalSelectedSize,
        formattedSize: formatBytes(totalSelectedSize)
    };
}

/**
 * Updates the repository URL for state persistence.
 * @param {string} repoUrl - The new repository URL
 */
function updateRepoUrl(repoUrl) {
    if (repoUrl && typeof repoUrl === 'string') {
        currentRepoUrl = repoUrl;
    }
}

export {
    initState,
    resetState,
    loadAndApplySelectionState,
    calculateSelectedTotals,
    handleTreeStateUpdate,
    saveSelectionState,
    getSelectionStateForActions,
    getSelectionMetrics,
    updateRepoUrl
};

console.log("[Popup State] Module loaded.");