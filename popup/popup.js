// file path: popup/popup.js
import { getGitHubPat, getRepoSelectionState, setRepoSelectionState } from '../common/storage.js';
import { parseRepoUrl, getRepoTree, getFileContentBySha } from '../common/github_api.js';

console.log("[Popup] Script loading...");

// --- Constants ---
const IS_DEBUG = true; // Set to false to reduce console noise in production builds
const LOG_PREFIX = "[Popup]";
const CONTEXT_PREFIX_PATH = 'assets/context_prefix.txt';
const COLLAPSED_ICON = '\u25B6'; // ►
const EXPANDED_ICON = '\u25BC'; // ▼
const FOLDER_ICON = '\u{1F4C1}'; // 📁
const FILE_ICON = '\u{1F4C4}'; // 📄
const REFRESH_ICON = '\u21BB'; // Or use the existing entity if preferred: '↻' / '↺'
const COPY_ICON = '\u{1F4CB}'; // Or use the existing entity if preferred: '📋' / '📎'
const DEFAULT_LOAD_TIME_TEXT = "";
const CHECKBOX_DEBOUNCE_DELAY = 250; // ms delay for debouncing checkbox persistence

// --- DOM Elements ---
const repoTitleElement = document.getElementById('repo-title');
const copyButton = document.getElementById('copy-button');
const refreshButton = document.getElementById('refresh-button');
const statusMessageElement = document.getElementById('status-message');
const errorMessageElement = document.getElementById('error-message');
const expandAllButton = document.getElementById('expand-all');
const collapseAllButton = document.getElementById('collapse-all');
const selectedCountElement = document.getElementById('selected-count');
const selectedSizeElement = document.getElementById('selected-size');
const fileTreeContainer = document.getElementById('file-tree-container');
const loadingIndicator = document.querySelector('.loading-indicator');
const perfStatsElement = document.getElementById('perf-stats');

// --- State Variables ---
let currentRepoUrl = null;
let currentOwner = null;
let currentRepo = null;
let fileTreeData = []; // Raw flat tree data from API { path, type, sha, size }
let treeHierarchy = {}; // Nested structure built for rendering
let selectionState = {}; // { 'path/to/file': true, 'path/to/folder/': false }
let isTruncated = false; // Flag if the repo tree from API was truncated
let totalSelectedFiles = 0;
let totalSelectedSize = 0;
let debounceTimer = null; // Timer for debouncing selection state saving

// --- Logging Helper ---
/**
 * Logs messages with a prefix, respecting the IS_DEBUG flag for non-error messages.
 * @param {string} level - 'log', 'warn', 'error', 'info'
 * @param {string} message - The message to log.
 * @param {...any} args - Additional arguments to log.
 */
function log(level, message, ...args) {
    if (level === 'error' || level === 'warn' || IS_DEBUG) {
        const fn = console[level] || console.log;
        fn(`${LOG_PREFIX} ${message}`, ...args);
    }
}

// --- Initialization ---

/**
 * Initializes the popup by getting the current tab's URL and loading repository data.
 */
async function initializePopup() {
    log('info', "Initializing...");
    showStatus("Detecting GitHub repository...");
    perfStatsElement.textContent = DEFAULT_LOAD_TIME_TEXT; // Clear perf stats
    const startTime = performance.now();

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0 || !tabs[0].url) {
            log('warn', "Could not get active tab info. Tabs:", tabs);
            throw new Error("Could not get active tab URL. Is a tab active?");
        }

        currentRepoUrl = tabs[0].url;
        log('info', `Current URL: ${currentRepoUrl}`);

        // Clear previous state before parsing new URL
        clearMessages();
        fileTreeContainer.innerHTML = ''; // Clear tree
        repoTitleElement.textContent = 'Loading...';
        disableControls(); // Disable buttons while loading

        const repoInfo = parseRepoUrl(currentRepoUrl);
        if (!repoInfo) {
            throw new Error("URL does not look like a GitHub repository page.");
        }

        currentOwner = repoInfo.owner;
        currentRepo = repoInfo.repo;
        repoTitleElement.textContent = `${currentOwner}/${currentRepo}`;
        repoTitleElement.title = `${currentOwner}/${currentRepo}`; // Add tooltip

        await loadRepoData();

        const endTime = performance.now();
        perfStatsElement.textContent = `Load time: ${((endTime - startTime) / 1000).toFixed(2)}s`;

    } catch (error) {
        log('error', "Initialization failed:", error);
        // log('error', error.stack); // Log stack trace for detailed debugging
        showError(`Initialization failed: ${error.message}`);
        repoTitleElement.textContent = "Error Loading";
        if(loadingIndicator) loadingIndicator.style.display = 'none'; // Hide loading
        disableControls();
        refreshButton.disabled = false; // Still allow refresh on error
    } finally {
        // Re-enable refresh only after everything else is potentially enabled/disabled
        // unless initialization completely failed before loadRepoData could run
        if (refreshButton) refreshButton.disabled = false;
    }
}

/** Fetches repository tree data, loads selection state, and renders the file tree. */
async function loadRepoData() {
    log('info', `Loading repository data for ${currentOwner}/${currentRepo}`);
    showStatus(`Fetching file tree for ${currentOwner}/${currentRepo}...`);
    if(loadingIndicator) loadingIndicator.style.display = 'block';
    fileTreeContainer.innerHTML = ''; // Clear previous tree
    if (loadingIndicator) fileTreeContainer.appendChild(loadingIndicator); // Add loading indicator
    disableControls(); // Disable controls during load

    // Reset state for this load attempt
    resetState();

    try {
        const repoTreeResult = await getRepoTree(currentOwner, currentRepo);
        fileTreeData = repoTreeResult.tree.filter(item => item.type === 'blob' || item.type === 'tree');
        isTruncated = repoTreeResult.truncated;
        log('info', `Received ${fileTreeData.length} filtered tree items. Truncated: ${isTruncated}`);

        if (fileTreeData.length === 0 && !isTruncated) {
           showStatus("Repository appears to be empty or inaccessible.", true);
           if(loadingIndicator) loadingIndicator.style.display = 'none';
           refreshButton.disabled = false;
           return;
        }

        await loadAndApplySelectionState(); // Load or default selection state

        renderFileTree(); // Renders based on selectionState
        calculateSelectedTotals(); // Initial calculation based on loaded state
        updateSelectionInfo(); // Updates counts, size, and button states

        // Enable controls now that tree is loaded
        enableControlsBasedOnState();

        clearMessages(); // Clear "Loading..." message
        if (isTruncated) {
            showStatus("Warning: Repository tree is large and may be incomplete.", true);
        }

    } catch (error) {
        log('error', "Failed to load repository data:", error);
        // log('error', error.stack);
        showError(`Error loading data: ${error.message}. Check console.`);
        if(loadingIndicator) loadingIndicator.style.display = 'none';
        disableControls(); // Keep controls disabled on load error
        refreshButton.disabled = false; // Allow refresh
    }
}

/** Resets the core state variables. */
function resetState() {
    log('info', 'Resetting internal state.');
    fileTreeData = [];
    treeHierarchy = {};
    selectionState = {};
    isTruncated = false;
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
    updateSelectionInfo(); // Reflect reset state in UI
}

/** Loads persisted selection state or defaults to all selected. */
async function loadAndApplySelectionState() {
    const persistedState = await getRepoSelectionState(currentRepoUrl);
    selectionState = {}; // Start fresh

    const currentKeys = new Set(fileTreeData.map(item => getItemPathKey(item)));

    if (persistedState) {
        log('info', "Applying persisted selection state.");
        // Prune state: only keep keys that exist in the current fileTreeData
        for (const key in persistedState) {
            if (currentKeys.has(key)) {
                selectionState[key] = persistedState[key];
            } else {
                 log('log', `Pruning stale key from loaded state: ${key}`);
            }
        }
        // Ensure all current items have *some* state (default to true if missing after prune)
        fileTreeData.forEach(item => {
            const key = getItemPathKey(item);
            if (selectionState[key] === undefined) {
                log('log', `Setting default 'true' for missing key after prune: ${key}`);
                selectionState[key] = true; // Default to selected
            }
        });

    } else {
        log('info', "No persisted state found, defaulting to all selected.");
        fileTreeData.forEach(item => {
            selectionState[getItemPathKey(item)] = true; // Default to selected
        });
    }
}

/** Disables primary action buttons, typically during loading or error states. */
function disableControls() {
    if (copyButton) copyButton.disabled = true;
    if (expandAllButton) expandAllButton.disabled = true;
    if (collapseAllButton) collapseAllButton.disabled = true;
    if (refreshButton) refreshButton.disabled = true; // Also disable refresh during intermediate states
}

/** Enables controls based on the current state (e.g., after loading). */
function enableControlsBasedOnState() {
    const hasItems = fileTreeData.length > 0;
    if (copyButton) copyButton.disabled = totalSelectedFiles === 0;
    if (expandAllButton) expandAllButton.disabled = !hasItems;
    if (collapseAllButton) collapseAllButton.disabled = !hasItems;
    if (refreshButton) refreshButton.disabled = false; // Always enable refresh post-load/attempt
}


// --- Helper Functions ---

/**
 * Gets the canonical key for an item used in selectionState. Folders end with '/'.
 * @param {{path: string, type: 'blob' | 'tree'}} item - The file tree item.
 * @returns {string} The path key.
 */
function getItemPathKey(item) {
    return item.type === 'tree' ? `${item.path}/` : item.path;
}

/**
 * Finds all descendant paths (files and folders) for a given folder path key.
 * @param {string} folderPathKey - The path key of the folder (e.g., "src/utils/"). Must end with '/'.
 * @returns {string[]} - An array of full path keys for all descendants.
 */
function getDescendantPaths(folderPathKey) {
    if (!folderPathKey.endsWith('/')) {
        log('warn', "getDescendantPaths called with non-folder path key:", folderPathKey);
        return [];
    }
    const descendants = [];
    const folderBasePath = folderPathKey.slice(0, -1);
    // Handle root folder comparison correctly (prefix is empty string)
    const pathPrefix = folderBasePath ? folderBasePath + '/' : '';

    for (const item of fileTreeData) {
        // Check if item.path starts with the folder's path prefix AND is not the folder itself.
        // Also handle root level items correctly (when pathPrefix is '').
        if (item.path.startsWith(pathPrefix) && (pathPrefix === '' || item.path !== folderBasePath)) {
             descendants.push(getItemPathKey(item));
        }
    }
    // log('log', `Descendants for ${folderPathKey}:`, descendants);
    return descendants;
}

/**
 * Finds the parent folder path key for a given path key.
 * @param {string} itemPathKey - The path key of the file or folder.
 * @returns {string | null} - The parent folder path key ending with '/', or null if it's a root item.
 */
function getParentFolderPath(itemPathKey) {
    const path = itemPathKey.endsWith('/') ? itemPathKey.slice(0, -1) : itemPathKey;
    const lastSlashIndex = path.lastIndexOf('/');

    if (lastSlashIndex === -1) {
        return null; // Root level item
    }
    return path.substring(0, lastSlashIndex) + '/';
}

// --- Calculation Function ---
/**
 * Recalculates the total number and size of selected files based on selectionState.
 * Updates the global totalSelectedFiles and totalSelectedSize variables.
 */
function calculateSelectedTotals() {
    // log('log', "Calculating selected totals...");
    let count = 0;
    let size = 0;

    for (const pathKey in selectionState) {
        if (!pathKey.endsWith('/') && selectionState[pathKey] === true) {
            const fileData = fileTreeData.find(item => item.path === pathKey && item.type === 'blob');
            if (fileData && typeof fileData.size === 'number') {
                count++;
                size += fileData.size;
            } else if (fileData) {
                log('warn', `File data found for ${pathKey} but size is missing or invalid:`, fileData.size);
            } else {
                 // This might happen if state becomes inconsistent, e.g., after a refresh removed a file
                 // log('warn', `No file data found in fileTreeData for selected path key: ${pathKey}. State might be stale.`);
            }
        }
    }

    totalSelectedFiles = count;
    totalSelectedSize = size;
    // log('log', `Calculation complete: ${totalSelectedFiles} files, ${formatBytes(totalSelectedSize)}`);
}

// --- UI Update Functions ---
/**
 * Displays a status message to the user. Clears error message.
 * @param {string} message The message to display.
 * @param {boolean} [isWarning=false] If true, uses error styling but it's just a status.
 */
function showStatus(message, isWarning = false) {
    log('info', `Status: ${message} ${isWarning ? '(Warning)' : ''}`);
    if (!statusMessageElement || !errorMessageElement) return;
    errorMessageElement.classList.add('hidden');
    errorMessageElement.textContent = '';
    statusMessageElement.textContent = message;
    statusMessageElement.classList.remove('hidden', 'error', 'status');
    statusMessageElement.classList.add(isWarning ? 'error' : 'status');
}

/**
 * Displays an error message to the user. Clears status message.
 * @param {string} message The error message to display.
 */
function showError(message) {
    log('error', `Error displayed: ${message}`);
    if (!statusMessageElement || !errorMessageElement) return;
    statusMessageElement.classList.add('hidden');
    statusMessageElement.textContent = '';
    errorMessageElement.textContent = message;
    errorMessageElement.classList.remove('hidden');
}

/** Clears any currently displayed status or error messages. */
function clearMessages() {
    if (!statusMessageElement || !errorMessageElement) return;
    statusMessageElement.classList.add('hidden');
    errorMessageElement.classList.add('hidden');
    statusMessageElement.textContent = '';
    errorMessageElement.textContent = '';
}

/**
 * Updates the display of selected file count and total size.
 * Assumes calculateSelectedTotals() has been called before this.
 * Also enables/disables the Copy button based on selection count.
 */
function updateSelectionInfo() {
    if (!selectedCountElement || !selectedSizeElement || !copyButton) return;
    selectedCountElement.textContent = `Selected: ${totalSelectedFiles} files`;
    selectedSizeElement.textContent = `Total Size: ${formatBytes(totalSelectedSize)}`;
    copyButton.disabled = (totalSelectedFiles === 0);
    // log('log', `UI selection info updated: ${totalSelectedFiles} files, ${formatBytes(totalSelectedSize)}. Copy button disabled: ${copyButton.disabled}`);
}

/**
 * Formats bytes into a human-readable string (B, KB, MB, GB).
 * @param {number | null | undefined} bytes The number of bytes.
 * @param {number} [decimals=2] The number of decimal places.
 * @returns {string} Formatted string.
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes == null || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const index = Math.max(0, Math.min(i, sizes.length - 1));
    return parseFloat((bytes / Math.pow(k, index)).toFixed(dm)) + ' ' + sizes[index];
}


// --- Core Rendering Logic ---
/**
 * Builds the hierarchical tree structure from the flat API data.
 * @param {Array<object>} items - The flat list of file tree items from the API.
 * @returns {object} A nested object representing the file tree.
 */
function buildTreeHierarchy(items) {
    const tree = {};
    // Sort items alphabetically by path for consistent order before building
    items.sort((a, b) => a.path.localeCompare(b.path));

    for (const item of items) {
        const parts = item.path.split('/');
        let currentLevel = tree;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLastPart = i === parts.length - 1;
            const currentPathSegment = parts.slice(0, i + 1).join('/');

            if (!currentLevel[part]) {
                // If the node doesn't exist, create it.
                // If it's the last part, use the actual item data.
                // If it's an intermediate part, create a placeholder folder node.
                currentLevel[part] = {
                    __data: isLastPart ? item : { path: currentPathSegment, type: 'tree', sha: null, size: null },
                    __children: item.type === 'tree' ? {} : null // Initialize children if it's a folder
                };
                 // If an intermediate path segment wasn't explicitly listed as 'tree' by API,
                 // ensure its __children is an object.
                 if (!isLastPart && currentLevel[part].__children === null) {
                    currentLevel[part].__children = {};
                 }

            } else {
                 // Node already exists (e.g., created as intermediate folder).
                 // Update its data if this is the actual item for this path.
                 if (isLastPart) {
                     currentLevel[part].__data = item;
                     // Ensure __children is correctly set based on the final item type
                     if (item.type === 'tree' && currentLevel[part].__children === null) {
                          log('log', `Updating existing node to folder and adding __children for: ${part}`);
                          currentLevel[part].__children = {};
                     } else if (item.type === 'blob') {
                         currentLevel[part].__children = null; // Blobs have no children
                     }
                 }
                 // Ensure intermediate nodes have a __children object if they don't already.
                 else if (!currentLevel[part].__children) {
                     log('log', `Ensuring intermediate node has __children object: ${part}`);
                     currentLevel[part].__children = {};
                     // Ensure the __data type reflects it's an intermediate path (folder)
                      if (!currentLevel[part].__data || currentLevel[part].__data.type !== 'tree') {
                          currentLevel[part].__data = { ...(currentLevel[part].__data || {}), path: currentPathSegment, type: 'tree' };
                      }
                 }
            }

            // Move down to the next level in the hierarchy.
            // This should only happen if __children is an object (i.e., it's a folder).
            if (currentLevel[part] && currentLevel[part].__children) {
                 currentLevel = currentLevel[part].__children;
            } else if (!isLastPart) {
                 // This case should theoretically not be reached if logic above is correct,
                 // but added as a safeguard/debug point.
                 log('error', `Tree building error: Expected folder at '${part}' for path '${item.path}', but node structure is problematic. Node:`, currentLevel[part]);
                 // To prevent infinite loops or errors, stop processing this path.
                 break;
            }
        }
    }
    return tree;
}


/** Renders the file tree HTML based on the hierarchical data. */
function renderFileTree() {
    log('info', "Rendering file tree...");
    if(!fileTreeContainer) return;
    if(loadingIndicator) loadingIndicator.style.display = 'none';
    fileTreeContainer.innerHTML = ''; // Clear previous content or loading indicator

    try {
        treeHierarchy = buildTreeHierarchy(fileTreeData);

        const rootElement = document.createElement('ul');
        rootElement.className = 'tree-root';
        rootElement.style.paddingLeft = '0';
        rootElement.style.listStyle = 'none';

        // Start recursion from the root level
        createTreeNodesRecursive(treeHierarchy, rootElement);

        fileTreeContainer.appendChild(rootElement);
        log('info', "File tree rendering complete.");

        addTreeEventListeners(); // Add listeners AFTER rendering
    } catch (error) {
         log('error', "Error during file tree rendering:", error);
         // log('error', error.stack);
         showError(`Failed to render file tree: ${error.message}`);
         fileTreeContainer.innerHTML = '<div class="error">Failed to display file tree.</div>';
    }
}

/**
 * Recursively creates HTML elements for the file tree.
 * @param {object} node Current level in the treeHierarchy.
 * @param {HTMLElement} parentElement The parent UL element to append to.
 */
function createTreeNodesRecursive(node, parentElement) {
    // Sort keys: folders first, then files, alphabetically within type
    const keys = Object.keys(node).sort((a, b) => {
        const nodeA = node[a];
        const nodeB = node[b];
        // Handle cases where __data might be missing (though ideally shouldn't happen)
        const typeA = nodeA?.__data?.type === 'tree' ? 0 : 1;
        const typeB = nodeB?.__data?.type === 'tree' ? 0 : 1;
        if (typeA !== typeB) return typeA - typeB; // Sort by type (folder first)
        return a.localeCompare(b); // Sort alphabetically
    });

    for (const key of keys) {
        const itemNode = node[key];
        if (!itemNode || !itemNode.__data) {
             log('warn', `Skipping node render, missing __data for key: ${key}`);
             continue;
        }
        const itemData = itemNode.__data;
        const isFolder = itemData.type === 'tree';
        const nodeKey = getItemPathKey(itemData); // Use helper for consistency

        const li = document.createElement('li');
        li.className = `tree-node ${isFolder ? 'folder' : 'file'}`;
        li.dataset.path = nodeKey;
        if (isFolder) {
            li.classList.add('collapsed'); // Folders start collapsed
        }

        // --- Structure Change: Use a div for the main row content ---
        const nodeContentRow = document.createElement('div');
        nodeContentRow.className = 'tree-node-content'; // Add class for potential styling
        // Apply flex directly to this row div for alignment
        nodeContentRow.style.display = 'flex';
        nodeContentRow.style.alignItems = 'center';
        nodeContentRow.style.padding = '3px 0'; // Mimic old padding

        // Checkbox
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const safeId = `cb_${nodeKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        checkbox.id = safeId;
        checkbox.dataset.path = nodeKey;
        checkbox.checked = !!selectionState[nodeKey]; // Set checked based on state
        checkbox.indeterminate = false; // Will be updated below if needed
        checkbox.style.marginRight = '6px'; // Keep original margin
        checkbox.style.flexShrink = '0'; // Keep original shrink rule
        nodeContentRow.appendChild(checkbox); // Add checkbox to the row div

        // Toggler (for folders with children) - Now outside the label
        const toggler = document.createElement('span');
        toggler.className = 'toggler';
        const hasChildren = isFolder && itemNode.__children && Object.keys(itemNode.__children).length > 0;
        if (hasChildren) {
            toggler.textContent = COLLAPSED_ICON;
            toggler.title = "Expand/Collapse";
        } else {
             // Use a non-breaking space for alignment, ensure it takes up space like the icon
             toggler.innerHTML = ' '; // Non-breaking space
             toggler.style.display = 'inline-block'; // Needed for width/height
             toggler.style.width = '1em'; // Reserve space similar to icon
             toggler.style.textAlign = 'center'; // Center space if needed
             if(isFolder) li.classList.remove('collapsed'); // Ensure empty folders aren't styled as collapsed visually
        }
        toggler.style.marginRight = '4px'; // Keep original margin
        toggler.style.cursor = 'pointer'; // Ensure cursor indicates interactivity
        toggler.style.flexShrink = '0'; // Keep original shrink rule
        nodeContentRow.appendChild(toggler); // Add toggler to the row div

        // Label container (now only contains icon, name, meta)
        const label = document.createElement('label');
        label.htmlFor = safeId;
        // Apply flex to label itself for internal content alignment
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.flexGrow = '1'; // Allow label to take remaining space
        label.style.overflow = 'hidden'; // Keep overflow handling
        label.style.cursor = 'pointer'; // Standard label cursor

        // Icon (folder/file)
        const icon = document.createElement('span');
        icon.className = 'node-icon';
        icon.textContent = isFolder ? FOLDER_ICON : FILE_ICON;
        icon.style.marginRight = '4px'; // Keep original margin
        icon.style.width = '16px'; // Keep original width
        icon.style.height = '16px'; // Keep original height
        icon.style.display = 'inline-block'; // Keep original display
        icon.style.verticalAlign = 'middle'; // Keep original align
        icon.style.flexShrink = '0'; // Keep original shrink
        label.appendChild(icon);

        // Name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'node-name';
        nameSpan.textContent = key; // Display the base name part
        nameSpan.title = itemData.path; // Full path in tooltip
        nameSpan.style.whiteSpace = 'nowrap'; // Keep original styles
        nameSpan.style.overflow = 'hidden';
        nameSpan.style.textOverflow = 'ellipsis';
        nameSpan.style.marginRight = '5px';
        label.appendChild(nameSpan);

        // Metadata (size for files)
        const metaSpan = document.createElement('span');
        metaSpan.className = 'node-meta';
        if (!isFolder && itemData.size != null) {
            metaSpan.textContent = formatBytes(itemData.size);
        }
        // Keep original meta styles
        metaSpan.style.fontSize = '0.9em';
        metaSpan.style.color = '#586069';
        metaSpan.style.marginLeft = 'auto';
        metaSpan.style.paddingLeft = '10px';
        metaSpan.style.flexShrink = '0';
        label.appendChild(metaSpan);

        // Add label (with its contents) to the row div
        nodeContentRow.appendChild(label);

        // Add the complete row div to the LI
        li.appendChild(nodeContentRow);

        // Append the LI to the parent UL
        parentElement.appendChild(li);

        // Determine folder checkbox state AFTER initial creation and adding to DOM/parent
        if (isFolder) {
             updateFolderCheckboxState(checkbox, nodeKey);
        }

        // Recurse for children if it's a folder with children
        if (hasChildren) {
            const childrenUl = document.createElement('ul');
            childrenUl.className = 'tree-node-children';
            // Apply indentation and reset list styles
            childrenUl.style.marginLeft = '20px'; // Adjust as needed
            childrenUl.style.paddingLeft = '0';
            childrenUl.style.listStyle = 'none';
            // Append children UL directly to the LI (will appear below the nodeContentRow)
            li.appendChild(childrenUl);
            createTreeNodesRecursive(itemNode.__children, childrenUl);
        }
    }
}

/** Adds event listeners to the dynamically generated tree using event delegation. */
function addTreeEventListeners() {
     log('info', "Adding tree event listeners...");
     if (!fileTreeContainer) return;
     // Remove existing listeners before adding new ones to prevent duplicates on refresh
     fileTreeContainer.removeEventListener('change', handleCheckboxChange);
     fileTreeContainer.removeEventListener('click', handleTreeClick);
     // Add new listeners
     fileTreeContainer.addEventListener('change', handleCheckboxChange);
     fileTreeContainer.addEventListener('click', handleTreeClick);
     log('info', "Tree event listeners added.");
}

// --- Event Handlers ---

/** Debounces the saving of the selection state */
function debounceSaveSelectionState() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
        try {
            // log('log', "Debounced: Persisting updated selection state...");
            const success = await setRepoSelectionState(currentRepoUrl, selectionState);
            if (!success) {
                log('error', "Debounced: Failed to persist selection state.");
                // Optionally show a temporary non-blocking warning
                 // showStatus("Warning: Could not save selection state.", true);
                 // setTimeout(clearMessages, 3000);
            } else {
                // log('log', "Debounced: Selection state persisted successfully.");
            }
        } catch (error) {
            log('error', "Debounced: Error persisting selection state:", error);
            // log('error', error.stack);
            // Optionally show a temporary non-blocking warning
            // showStatus("Warning: Error saving selection state.", true);
            // setTimeout(clearMessages, 3000);
        }
    }, CHECKBOX_DEBOUNCE_DELAY);
}


/**
 * Handles checkbox changes in the file tree. Updates selection state,
 * propagates changes, persists state (debounced), and updates UI.
 * @param {Event} event - The change event object.
 */
function handleCheckboxChange(event) {
    if (event.target.type !== 'checkbox' || !event.target.dataset.path) return;

    const checkbox = event.target;
    const pathKey = checkbox.dataset.path;
    let isChecked = checkbox.checked;

    log('log', `Checkbox changed: ${pathKey}, Checked: ${isChecked}, Indeterminate: ${checkbox.indeterminate}`);

    // When an indeterminate checkbox is clicked, it becomes checked (or unchecked depending on browser, usually checked)
    // Clear indeterminate state explicitly
    if (checkbox.indeterminate) {
        checkbox.indeterminate = false;
        // Force the state to match the visual change (usually becomes checked)
        isChecked = checkbox.checked;
    }

    // Update state for the clicked item
    selectionState[pathKey] = isChecked;

    const isFolder = pathKey.endsWith('/');

    // --- Propagation ---
    // 1. Downwards (if folder changed)
    if (isFolder) {
        propagateStateToDescendants(pathKey, isChecked);
    }

    // 2. Upwards (update parent folders)
    propagateStateToAncestors(pathKey);

    // --- UI & Persistence ---
    // Recalculate totals and update UI display
    calculateSelectedTotals();
    updateSelectionInfo();

    // Debounce persistence
    debounceSaveSelectionState();
}

/**
 * Propagates the selection state change downwards to all descendants.
 * @param {string} folderPathKey - The path key of the folder that changed.
 * @param {boolean} isChecked - The new checked state to propagate.
 */
function propagateStateToDescendants(folderPathKey, isChecked) {
    log('log', `Propagating state (${isChecked}) down from ${folderPathKey}`);
    const descendants = getDescendantPaths(folderPathKey);
    descendants.forEach(descendantPathKey => {
        if (selectionState[descendantPathKey] !== isChecked) {
             selectionState[descendantPathKey] = isChecked;
        }
        // Update descendant checkboxes visually
        const descendantCheckbox = fileTreeContainer?.querySelector(`input[type="checkbox"][data-path="${CSS.escape(descendantPathKey)}"]`);
        if (descendantCheckbox) {
            descendantCheckbox.checked = isChecked;
            descendantCheckbox.indeterminate = false; // Explicit state from parent, not indeterminate
        }
    });
}

/**
 * Updates the checked and indeterminate state of ancestor folders based on their children's states.
 * @param {string} changedPathKey - The path key of the item that triggered the update.
 */
function propagateStateToAncestors(changedPathKey) {
    log('log', `Propagating state up from ${changedPathKey}`);
    let parentPathKey = getParentFolderPath(changedPathKey);
    while (parentPathKey) {
        const parentCheckbox = fileTreeContainer?.querySelector(`input[type="checkbox"][data-path="${CSS.escape(parentPathKey)}"]`);
        if (!parentCheckbox) {
             log('warn', `Could not find parent checkbox DOM element for path: ${parentPathKey}`);
             break; // Stop propagation if parent DOM element is missing
        }

        updateFolderCheckboxState(parentCheckbox, parentPathKey);

        // Move to the next parent up
        parentPathKey = getParentFolderPath(parentPathKey);
    }
}

/**
 * Updates a folder's checkbox state (checked, unchecked, indeterminate) based on its direct children's states.
 * Also updates the selectionState for the folder itself.
 * @param {HTMLInputElement} checkbox - The folder's checkbox element.
 * @param {string} folderPathKey - The folder's path key.
 */
function updateFolderCheckboxState(checkbox, folderPathKey) {
    // Find direct children *currently rendered* (could be different from all descendants if tree is partially loaded/rendered)
    // A more reliable way is to check selectionState for items whose parent is this folder.
    const directChildrenKeys = Object.keys(selectionState).filter(k => getParentFolderPath(k) === folderPathKey);

    if (directChildrenKeys.length === 0) {
        // No children in the state map, folder state is determined by its own explicit check or default.
        // If it was explicitly clicked, its state is already set. If not, it might be default true or loaded state.
        // For safety, ensure indeterminate is false if no children.
        checkbox.indeterminate = false;
        // Ensure the selection state reflects the checkbox visual state if no children influence it.
        selectionState[folderPathKey] = checkbox.checked;
        // log('log', `Folder ${folderPathKey} has no tracked children. State: ${checkbox.checked}`);
        return;
    }

    const childrenStates = directChildrenKeys.map(k => selectionState[k]);
    const allChecked = childrenStates.every(state => state === true);
    const noneChecked = childrenStates.every(state => state === false || state === undefined); // Consider undefined as not checked

    if (allChecked) {
         selectionState[folderPathKey] = true;
         checkbox.checked = true;
         checkbox.indeterminate = false;
         // log('log', `Folder ${folderPathKey} set to checked (all children checked).`);
    } else if (noneChecked) {
        selectionState[folderPathKey] = false;
        checkbox.checked = false;
        checkbox.indeterminate = false;
        // log('log', `Folder ${folderPathKey} set to unchecked (all children unchecked).`);
    } else {
         // Mixed states among children
         selectionState[folderPathKey] = false; // Treat indeterminate as 'not fully selected' in state
         checkbox.checked = false; // Visually appears unchecked but indeterminate
         checkbox.indeterminate = true;
         // log('log', `Folder ${folderPathKey} set to indeterminate (mixed children states).`);
    }
}


/**
 * Handles clicks within the tree container, specifically for toggling folders.
 * Stops event propagation if the click is specifically on the toggler element.
 * @param {Event} event - The click event object.
 */
function handleTreeClick(event) {
    // Check if the click target is specifically the toggler span
    if (event.target.classList.contains('toggler')) {
        const toggler = event.target;
        const nodeLi = toggler.closest('.tree-node.folder'); // Find the parent LI

        // Ensure we are on a folder and it actually has children to toggle
        if (nodeLi && nodeLi.querySelector(':scope > .tree-node-children')) {
            log('log', `Toggler clicked for: ${nodeLi.dataset.path}`);
            const isCollapsed = nodeLi.classList.toggle('collapsed');
            toggler.textContent = isCollapsed ? COLLAPSED_ICON : EXPANDED_ICON;

            // --- CRITICAL CHANGE ---
            // Stop the event propagation HERE, so the click on the toggler
            // doesn't bubble up and trigger the label or any other handlers unintentionally.
            event.stopPropagation();
            // log('log', `Stopped event propagation for toggler click on ${nodeLi.dataset.path}`);
        } else if (nodeLi) {
             // Clicked toggler area on a folder with no children, do nothing significant.
             // Still stop propagation just in case.
             event.stopPropagation();
        }
    }
    // If the click was not on a toggler, let it bubble.
    // This allows clicks on the label (icon, name, meta) to still trigger the checkbox via the label's 'for' attribute,
    // and clicks on the checkbox itself to work as expected.
}


// --- Action Button Handlers ---

/**
 * Fetches the context prefix string from the assets file.
 * @returns {Promise<string>} The prefix string (with trailing newlines) or an empty string if fetch fails.
 */
async function getContextPrefix() {
    try {
        const prefixUrl = chrome.runtime.getURL(CONTEXT_PREFIX_PATH);
        log('info', `Fetching context prefix from: ${prefixUrl}`);
        const response = await fetch(prefixUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch prefix: ${response.status} ${response.statusText}`);
        }
        const prefixText = await response.text();
        log('info', "Successfully fetched context prefix.");
        // Ensure consistent formatting with trailing newlines if not empty
        return prefixText.trim() ? prefixText.trimEnd() + '\n\n' : "";
    } catch (error) {
        log('error', `Error fetching context prefix from ${CONTEXT_PREFIX_PATH}:`, error);
        // log('error', error.stack);
        showError(`Error loading context prefix: ${error.message}. Ensure '${CONTEXT_PREFIX_PATH}' exists.`);
        return ""; // Return empty string on failure
    }
}


/** Handles the click on the "Copy Context" button. Fetches prefix and selected file contents. */
async function handleCopyClick() {
    log('info', "Copy button clicked.");
    if (!copyButton || copyButton.disabled || !currentOwner || !currentRepo) {
        log('warn', "Copy button clicked while disabled or repo info missing.");
        return;
    }

    const originalButtonHTML = copyButton.innerHTML;
    disableControls(); // Keep refresh enabled below
    refreshButton.disabled = false;
    copyButton.innerHTML = `<span class="icon">${REFRESH_ICON}</span> Copying...`; // Use refresh icon for busy state
    clearMessages();
    showStatus("Preparing context...");
    const startTime = performance.now();

    // 1. Fetch the prefix
    const contextPrefix = await getContextPrefix();
    // Continue even if prefix fetch failed (it returns "" and shows error)

    // 2. Identify selected files
    showStatus("Identifying selected files...");
    const selectedFilesToFetch = [];
    for (const pathKey in selectionState) {
        if (selectionState[pathKey] === true && !pathKey.endsWith('/')) {
            const fileData = fileTreeData.find(item => item.path === pathKey && item.type === 'blob');
            if (fileData && fileData.sha) {
                selectedFilesToFetch.push({ path: fileData.path, sha: fileData.sha });
            } else {
                 log('warn', `Could not find SHA for selected file: ${pathKey}. Skipping.`);
            }
        }
    }

     log('info', `Found ${selectedFilesToFetch.length} selected files with SHAs.`);

     if (selectedFilesToFetch.length === 0) {
         showError("No files selected to copy.");
         copyButton.innerHTML = originalButtonHTML; // Restore button
         enableControlsBasedOnState(); // Re-enable controls based on current state
         return;
     }

    // 3. Fetch file contents concurrently
    let filesProcessed = 0;
    let fetchErrors = 0;
    const totalToFetch = selectedFilesToFetch.length;
    showStatus(`Fetching content for ${totalToFetch} files... (0/${totalToFetch})`);

    let results = [];
    try {
        // Sort files alphabetically by path before fetching for consistent output order
        selectedFilesToFetch.sort((a, b) => a.path.localeCompare(b.path));

        const contentPromises = selectedFilesToFetch.map(file =>
            getFileContentBySha(currentOwner, currentRepo, file.sha)
                .then(content => {
                    filesProcessed++;
                    if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) {
                        showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    return { path: file.path, content: content, error: null }; // Consistent result structure
                })
                .catch(error => {
                    log('error', `Failed to fetch content for ${file.path} (SHA: ${file.sha}):`, error);
                    // log('error', error.stack);
                    fetchErrors++;
                    filesProcessed++;
                     if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) {
                        showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    return { path: file.path, content: null, error: error.message || "Unknown error" }; // Consistent error structure
                })
        );

        results = await Promise.all(contentPromises);
        const fetchEndTime = performance.now();
        log('info', `Content fetching completed in ${((fetchEndTime - startTime) / 1000).toFixed(2)}s.`);

    } catch (error) {
        // Catch potential errors in Promise.all or setup phase (unlikely here)
        log('error', "Unexpected error during content fetching phase:", error);
        // log('error', error.stack);
        showError(`Unexpected error gathering file content: ${error.message}`);
        copyButton.innerHTML = originalButtonHTML; // Restore button
        enableControlsBasedOnState();
        return;
    }

    // 4. Format the context
    showStatus("Formatting context...");
    let formattedContext = contextPrefix; // Start with the prefix
    results.forEach(result => {
        if (result.content !== null) { // Check for non-error results
            // Sanitize null bytes which can cause issues with clipboard/display
            const sanitizedContent = result.content.replace(/\0/g, '');
            formattedContext += `--- File: ${result.path} ---\n`; // New format
            formattedContext += `${sanitizedContent}\n\n`;
        } else {
             log('warn', `Skipping file in final output due to fetch error: ${result.path}`);
             // Optionally add a note about the failed file in the context:
             // formattedContext += `--- Error fetching file: ${result.path} ---\nError: ${result.error}\n\n`;
        }
    });

    // Remove trailing whitespace/newlines from the final string
    formattedContext = formattedContext.trimEnd();

    // 5. Copy to clipboard and provide feedback
    const filesCopiedCount = totalToFetch - fetchErrors;
    let finalMessage;
    let messageIsWarning = false;

    if (filesCopiedCount > 0) {
        finalMessage = `Context for ${filesCopiedCount} file(s) copied!`;
        if (fetchErrors > 0) {
            finalMessage += ` (${fetchErrors} failed)`;
            messageIsWarning = true;
        }
    } else if (fetchErrors > 0) {
        finalMessage = `Copy failed: Could not retrieve content for any of the ${fetchErrors} selected file(s).`;
        messageIsWarning = true; // Treat total failure as an error/warning
    } else {
        finalMessage = "Copy failed: No content generated."; // Should not happen if selectedFilesToFetch > 0 initially
        messageIsWarning = true;
    }

    try {
        if (formattedContext) { // Only copy if there is content
             await navigator.clipboard.writeText(formattedContext);
             log('info', "Formatted context copied to clipboard.");
             showStatus(finalMessage, messageIsWarning);
             // Attempt notification
             notifyUser('GitHub AI Context Builder', finalMessage);
        } else {
             log('warn', "Nothing to copy to clipboard (formatted context is empty).");
             if (fetchErrors === totalToFetch && totalToFetch > 0) {
                 showError(finalMessage); // Show the specific error about failing to retrieve files
             } else if (selectedFilesToFetch.length > 0) {
                  showError("Copy failed: Generated context is empty despite selected files.");
             }
              else {
                 showError("Copy failed: Nothing generated to copy."); // Generic fallback
             }
        }
    } catch (clipError) {
        log('error', "Failed to copy to clipboard:", clipError);
        // log('error', clipError.stack);
        showError(`Failed to copy: ${clipError.message}. Content may be too large or permission denied.`);
    } finally {
        // Restore button and controls
        copyButton.innerHTML = originalButtonHTML;
        enableControlsBasedOnState();
        const endTime = performance.now();
        log('info', `Total copy operation took ${((endTime - startTime) / 1000).toFixed(2)}s.`);
    }
}

/**
 * Attempts to send a system notification.
 * @param {string} title - Notification title.
 * @param {string} message - Notification message.
 */
async function notifyUser(title, message) {
    // Basic check if notifications API exists
    if (!chrome.notifications) {
        log('warn', 'Notifications API not available.');
        return;
    }
     try {
         // Check for permission using the Permissions API if available (more robust)
         let hasPermission = false;
         if (chrome.permissions?.contains) {
            hasPermission = await chrome.permissions.contains({ permissions: ['notifications'] });
         } else {
             // Fallback: Assume permission if API exists, less reliable.
             // In a real-world scenario, might need to request permission here.
             hasPermission = true;
             log('warn', 'Cannot verify notification permission via Permissions API. Assuming granted.');
         }

         if (hasPermission) {
              chrome.notifications.create({
                 type: 'basic',
                 // Ensure icons are defined in manifest.json under 'icons' and potentially 'web_accessible_resources' if needed elsewhere
                 iconUrl: chrome.runtime.getURL('icons/icon48.png'), // Make sure you have icons/icon48.png
                 title: title,
                 message: message
             }, (notificationId) => {
                 if (chrome.runtime.lastError) {
                     log('warn', 'Could not create notification:', chrome.runtime.lastError.message);
                 } else {
                     log('info', `Notification sent: ${notificationId}`);
                 }
             });
         } else {
             log('info', 'Notification permission not granted. Skipping notification.');
         }
     } catch (notifyError) {
         log('warn', 'Error checking notification permission or sending notification:', notifyError);
         // log('warn', notifyError.stack);
     }
}


/** Handles the click on the "Refresh" button. */
function handleRefreshClick() {
    log('info', "Refresh button clicked.");
    clearMessages();
    if (fileTreeContainer) fileTreeContainer.innerHTML = ''; // Clear the tree display immediately
    if (repoTitleElement) repoTitleElement.textContent = "Refreshing...";
    disableControls(); // Disable controls while refreshing

    // Reset internal state variables completely
    resetState();

    // Re-initialize the popup, which will fetch fresh data
    initializePopup(); // This will eventually re-enable controls via loadRepoData
}

/** Handles the click on the "Expand All" button. */
function handleExpandAll() {
    log('info', "Expand All clicked.");
    if (!fileTreeContainer) return;
    const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
    togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        // Check if it has children and is currently collapsed
        if (nodeLi && nodeLi.querySelector(':scope > .tree-node-children') && nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.remove('collapsed');
            toggler.textContent = EXPANDED_ICON;
        }
    });
}

/** Handles the click on the "Collapse All" button. */
function handleCollapseAll() {
     log('info', "Collapse All clicked.");
     if (!fileTreeContainer) return;
     const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
     togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        // Check if it has children and is not currently collapsed
        if (nodeLi && nodeLi.querySelector(':scope > .tree-node-children') && !nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.add('collapsed');
            toggler.textContent = COLLAPSED_ICON;
        }
    });
}


// --- Attach Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    log('info', "DOM Content Loaded. Initializing popup...");
    initializePopup();

    // Attach listeners for static buttons
    if (copyButton) copyButton.addEventListener('click', handleCopyClick);
    if (refreshButton) refreshButton.addEventListener('click', handleRefreshClick);
    if (expandAllButton) expandAllButton.addEventListener('click', handleExpandAll);
    if (collapseAllButton) collapseAllButton.addEventListener('click', handleCollapseAll);

    // Use more common unicode icons or HTML entities if needed
    const copyButtonIcon = copyButton?.querySelector('.icon');
    if (copyButtonIcon) copyButtonIcon.textContent = COPY_ICON; // Set icon text
    const refreshButtonIcon = refreshButton?.querySelector('.icon');
    if (refreshButtonIcon) refreshButtonIcon.textContent = REFRESH_ICON; // Set icon text


    log('info', "Static button listeners attached.");
    // Tree listeners are attached dynamically after rendering
});

log('info', "Popup script loaded.");