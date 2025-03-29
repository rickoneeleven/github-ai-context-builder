// file path: popup/popup.js
import { getGitHubPat, getRepoSelectionState, setRepoSelectionState } from '../common/storage.js';
import { parseRepoUrl, getRepoTree, getFileContentBySha } from '../common/github_api.js';

console.log("[Popup] Script loading...");

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

// --- Initialization ---

/**
 * Initializes the popup by getting the current tab's URL and loading repository data.
 */
async function initializePopup() {
    console.log("[Popup] Initializing...");
    showStatus("Detecting GitHub repository...");
    perfStatsElement.textContent = ""; // Clear perf stats
    const startTime = performance.now();

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0 || !tabs[0].url) {
            console.warn("[Popup] Could not get active tab info. Tabs:", tabs);
            throw new Error("Could not get active tab URL. Is a tab active in the current window?");
        }

        currentRepoUrl = tabs[0].url;
        console.log(`[Popup] Current URL: ${currentRepoUrl}`);

        // Clear previous state before parsing new URL
        clearMessages();
        fileTreeContainer.innerHTML = ''; // Clear tree
        repoTitleElement.textContent = 'Loading...';
        disableControls(); // Disable buttons while loading

        const repoInfo = parseRepoUrl(currentRepoUrl);
        if (!repoInfo) {
            throw new Error("URL does not look like a GitHub repository page. Cannot parse owner/repo.");
        }

        currentOwner = repoInfo.owner;
        currentRepo = repoInfo.repo;
        repoTitleElement.textContent = `${currentOwner}/${currentRepo}`;
        repoTitleElement.title = `${currentOwner}/${currentRepo}`; // Add tooltip

        await loadRepoData();

        const endTime = performance.now();
        perfStatsElement.textContent = `Load time: ${((endTime - startTime) / 1000).toFixed(2)}s`;
        // Re-enable refresh only after everything else is potentially enabled/disabled by loadRepoData
        refreshButton.disabled = false;

    } catch (error) {
        console.error("[Popup] Initialization failed:", error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
        showError(`Initialization failed: ${error.message}`);
        repoTitleElement.textContent = "Error Loading";
        if(loadingIndicator) loadingIndicator.style.display = 'none'; // Hide loading
        disableControls(); // Ensure controls are disabled on init error
        refreshButton.disabled = false; // Still allow refresh on error
    }
}

/** Fetches repository tree data, loads selection state, and renders the file tree. */
async function loadRepoData() {
    console.log(`[Popup] Loading repository data for ${currentOwner}/${currentRepo}`);
    showStatus(`Fetching file tree for ${currentOwner}/${currentRepo}...`);
    if(loadingIndicator) loadingIndicator.style.display = 'block';
    fileTreeContainer.innerHTML = ''; // Clear previous tree
    fileTreeContainer.appendChild(loadingIndicator); // Add loading indicator
    disableControls(); // Disable controls during load

    // Reset state for this load attempt
    fileTreeData = [];
    treeHierarchy = {};
    selectionState = {};
    isTruncated = false;
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
    updateSelectionInfo(); // Reflect reset state in UI

    try {
        // Fetch the tree structure - expecting { tree: Array, truncated: boolean }
        const repoTreeResult = await getRepoTree(currentOwner, currentRepo);

        // Assign tree and truncated status
        fileTreeData = repoTreeResult.tree;
        isTruncated = repoTreeResult.truncated;

        // Filter the extracted array
        fileTreeData = fileTreeData.filter(item => item.type === 'blob' || item.type === 'tree');
        console.log(`[Popup] Received and filtered ${fileTreeData.length} tree items. Truncated: ${isTruncated}`);

        if (fileTreeData.length === 0 && !isTruncated) { // Don't show "empty" if it was just truncated
           showStatus("Repository appears to be empty or inaccessible.", true);
           if(loadingIndicator) loadingIndicator.style.display = 'none';
           // Keep controls disabled except refresh
           refreshButton.disabled = false;
           return; // Nothing more to do
        }

        // Load persisted selection state or default to all checked
        const persistedState = await getRepoSelectionState(currentRepoUrl);
        if (persistedState) {
            console.log("[Popup] Loaded persisted selection state.");
            // Prune state: only keep keys that exist in the current fileTreeData
            const currentKeys = new Set(fileTreeData.map(item => item.type === 'tree' ? `${item.path}/` : item.path));
            selectionState = {};
            for (const key in persistedState) {
                if (currentKeys.has(key)) {
                    selectionState[key] = persistedState[key];
                } else {
                     console.log(`[Popup] Pruning stale key from loaded state: ${key}`);
                }
            }
             // Ensure all current items have *some* state (default to true if missing after prune)
            fileTreeData.forEach(item => {
                const key = item.type === 'tree' ? `${item.path}/` : item.path;
                if (selectionState[key] === undefined) {
                    console.log(`[Popup] Setting default 'true' for missing key after prune: ${key}`);
                    selectionState[key] = true; // Default to selected
                }
            });

        } else {
            console.log("[Popup] No persisted state found, defaulting to all selected.");
            selectionState = {};
            fileTreeData.forEach(item => {
                const key = item.type === 'tree' ? `${item.path}/` : item.path;
                selectionState[key] = true; // Default to selected
            });
        }

        // Build the hierarchical structure and render the tree
        renderFileTree(); // Renders based on selectionState

        // Calculate totals based on the loaded/default state BEFORE updating UI info
        calculateSelectedTotals();
        updateSelectionInfo(); // Updates counts, size, and button states (incl. copy)

        // Enable controls now that tree is loaded
        expandAllButton.disabled = fileTreeData.length === 0;
        collapseAllButton.disabled = fileTreeData.length === 0;
        // Copy button state is set inside updateSelectionInfo
        // Refresh button is enabled at the end of initializePopup or the catch block

        clearMessages(); // Clear "Loading..." message
        if (isTruncated) { // Check the flag
            showStatus("Warning: Repository tree is large and may be incomplete.", true);
        }

    } catch (error) {
        console.error("[Popup] Failed to load repository data:", error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
        // Display the specific error message from the caught error
        showError(`Error loading data: ${error.message}. Check console for details.`);
        if(loadingIndicator) loadingIndicator.style.display = 'none';
        // Keep controls disabled except refresh
        disableControls();
        refreshButton.disabled = false;
    }
}


/** Disables primary action buttons, typically during loading or error states. */
function disableControls() {
    copyButton.disabled = true;
    expandAllButton.disabled = true;
    collapseAllButton.disabled = true;
    refreshButton.disabled = true; // Also disable refresh during intermediate states
}

// --- Helper Functions ---
/**
 * Finds all descendant paths (files and folders) for a given folder path within the flat fileTreeData.
 * @param {string} folderPathKey - The path key of the folder (e.g., "src/utils/"). Must end with '/'.
 * @returns {string[]} - An array of full path keys for all descendants.
 */
function getDescendantPaths(folderPathKey) {
    if (!folderPathKey.endsWith('/')) {
        console.warn("[Popup] getDescendantPaths called with non-folder path key:", folderPathKey);
        return [];
    }
    const descendants = [];
    // Remove trailing slash for path comparison
    const folderBasePath = folderPathKey.slice(0, -1);
    const pathPrefix = folderBasePath ? folderBasePath + '/' : ''; // Handle root folder ""

    for (const item of fileTreeData) {
        // Check if item.path starts with the folder's base path + '/'
        // Exclude the folder itself
        if (item.path.startsWith(pathPrefix) && item.path !== folderBasePath) {
             const key = item.type === 'tree' ? `${item.path}/` : item.path;
             descendants.push(key);
        }
    }
    return descendants;
}

/**
 * Finds the parent folder path key for a given path key.
 * @param {string} itemPathKey - The path key of the file or folder (e.g., "src/utils/helpers.js" or "src/utils/").
 * @returns {string | null} - The parent folder path key ending with '/', or null if it's a root item.
 */
function getParentFolderPath(itemPathKey) {
    // Remove trailing slash if it's a folder path key for processing
    const path = itemPathKey.endsWith('/') ? itemPathKey.slice(0, -1) : itemPathKey;
    const lastSlashIndex = path.lastIndexOf('/');

    if (lastSlashIndex === -1) {
        return null; // Root level item
    }
    // Return the part before the last slash, adding a trailing slash to mark it as a folder key
    return path.substring(0, lastSlashIndex) + '/';
}


// --- Calculation Function ---
/**
 * Recalculates the total number and size of selected files based on selectionState.
 * Updates the global totalSelectedFiles and totalSelectedSize variables.
 */
function calculateSelectedTotals() {
    console.log("[Popup] Calculating selected totals...");
    let count = 0;
    let size = 0;

    for (const pathKey in selectionState) {
        // Only count files (keys not ending in '/') that are checked (true)
        if (!pathKey.endsWith('/') && selectionState[pathKey] === true) {
            // Find the corresponding file data item using the exact pathKey
            const fileData = fileTreeData.find(item => item.path === pathKey && item.type === 'blob');
            if (fileData && typeof fileData.size === 'number') {
                count++;
                size += fileData.size;
            } else if (fileData) {
                console.warn(`[Popup] File data found for ${pathKey} but size is missing or invalid:`, fileData.size);
            } else {
                 console.warn(`[Popup] No file data found in fileTreeData for selected path key: ${pathKey}. State might be stale.`);
            }
        }
    }

    totalSelectedFiles = count;
    totalSelectedSize = size;
    console.log(`[Popup] Calculation complete: ${totalSelectedFiles} files, ${formatBytes(totalSelectedSize)}`);
}

// --- UI Update Functions ---
/**
 * Displays a status message to the user. Clears error message.
 * @param {string} message The message to display.
 * @param {boolean} [isWarning=false] If true, uses error styling but it's just a status.
 */
function showStatus(message, isWarning = false) {
    console.log(`[Popup Status] ${message}`);
    errorMessageElement.classList.add('hidden'); // Hide error
    errorMessageElement.textContent = '';
    statusMessageElement.textContent = message;
    // Use classList to add/remove classes cleanly
    statusMessageElement.classList.remove('hidden', 'error', 'status'); // Remove all potentially existing classes
    statusMessageElement.classList.add(isWarning ? 'error' : 'status'); // Add the correct class
}

/**
 * Displays an error message to the user. Clears status message.
 * @param {string} message The error message to display.
 */
function showError(message) {
    console.error(`[Popup Error] ${message}`);
    statusMessageElement.classList.add('hidden'); // Hide status
    statusMessageElement.textContent = '';
    errorMessageElement.textContent = message;
    errorMessageElement.classList.remove('hidden'); // Show error
}

/** Clears any currently displayed status or error messages. */
function clearMessages() {
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
    selectedCountElement.textContent = `Selected: ${totalSelectedFiles} files`;
    selectedSizeElement.textContent = `Total Size: ${formatBytes(totalSelectedSize)}`;
    // Enable copy button only if > 0 files are selected
    copyButton.disabled = (totalSelectedFiles === 0);
    console.log(`[Popup] UI selection info updated: ${totalSelectedFiles} files, ${formatBytes(totalSelectedSize)}. Copy button disabled: ${copyButton.disabled}`);
}

/**
 * Formats bytes into a human-readable string (B, KB, MB, GB).
 * @param {number | null | undefined} bytes The number of bytes.
 * @param {number} [decimals=2] The number of decimal places.
 * @returns {string} Formatted string.
 */
function formatBytes(bytes, decimals = 2) {
    // Handle null/undefined/zero bytes robustly
    if (bytes == null || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']; // Added more sizes
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    // Ensure index is within bounds of sizes array, handle potential edge cases like very large numbers
    const index = Math.max(0, Math.min(i, sizes.length - 1));
    return parseFloat((bytes / Math.pow(k, index)).toFixed(dm)) + ' ' + sizes[index];
}


// --- Core Rendering Logic ---
/**
 * Builds the hierarchical tree structure from the flat API data.
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
                if (isLastPart) {
                    currentLevel[part] = {
                        __data: item,
                        __children: item.type === 'tree' ? {} : null
                    };
                } else {
                     currentLevel[part] = {
                         __data: { path: currentPathSegment, type: 'tree', sha: null, size: null },
                         __children: {}
                     };
                }
            } else {
                 if (isLastPart) {
                     currentLevel[part].__data = item;
                     if (item.type === 'tree' && !currentLevel[part].__children) {
                          console.warn(`[Popup] Adding missing __children during update for explicit folder: ${part}`);
                          currentLevel[part].__children = {};
                     } else if (item.type === 'blob') {
                         currentLevel[part].__children = null;
                     }
                 } else if (!currentLevel[part].__children) {
                      console.warn(`[Popup] Adding missing __children to existing intermediate node: ${part}`);
                      currentLevel[part].__children = {};
                      if (!currentLevel[part].__data || currentLevel[part].__data.type !== 'tree') {
                          currentLevel[part].__data = { ...(currentLevel[part].__data || {}), path: currentPathSegment, type: 'tree' };
                      }
                 }
            }

            if (currentLevel[part].__children) {
                 currentLevel = currentLevel[part].__children;
            } else if (!isLastPart) {
                 console.error(`[Popup] Tree building error: Expected folder at '${part}' for path '${item.path}', but found non-folder node.`);
                 break;
            }
        }
    }
    return tree;
}


/** Renders the file tree HTML based on the hierarchical data. */
function renderFileTree() {
    console.log("[Popup] Rendering file tree...");
    if(loadingIndicator) loadingIndicator.style.display = 'none';
    fileTreeContainer.innerHTML = ''; // Clear previous content or loading indicator

    treeHierarchy = buildTreeHierarchy(fileTreeData);

    const rootElement = document.createElement('ul');
    rootElement.className = 'tree-root';
    rootElement.style.paddingLeft = '0'; // Remove default UL padding
    rootElement.style.listStyle = 'none'; // Remove default UL bullets

    // Start recursion from the root level
    createTreeNodesRecursive(treeHierarchy, rootElement);

    fileTreeContainer.appendChild(rootElement);
    console.log("[Popup] File tree rendering complete.");

    addTreeEventListeners(); // Add listeners AFTER rendering
}

/**
 * Recursively creates HTML elements for the file tree.
 * Uses Unicode escapes for icons.
 * @param {object} node Current level in the treeHierarchy.
 * @param {HTMLElement} parentElement The parent UL element to append to.
 */
function createTreeNodesRecursive(node, parentElement) {
    const keys = Object.keys(node).sort((a, b) => {
        const nodeA = node[a];
        const nodeB = node[b];
        const typeA = nodeA.__data?.type === 'tree' ? 0 : 1;
        const typeB = nodeB.__data?.type === 'tree' ? 0 : 1;
        if (typeA !== typeB) return typeA - typeB;
        return a.localeCompare(b);
    });

    for (const key of keys) {
        const itemNode = node[key];
        if (!itemNode.__data) {
             console.warn(`[Popup] Skipping node render, missing __data for key: ${key}`);
             continue;
        }
        const itemData = itemNode.__data;
        const itemPath = itemData.path;
        const isFolder = itemData.type === 'tree';
        const nodeKey = isFolder ? `${itemPath}/` : itemPath;

        const li = document.createElement('li');
        li.className = `tree-node ${isFolder ? 'folder' : 'file'}`;
        if (isFolder) {
            li.classList.add('collapsed');
        }
        li.dataset.path = nodeKey;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const safeId = `cb_${nodeKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        checkbox.id = safeId;
        checkbox.dataset.path = nodeKey;

        const currentState = selectionState[nodeKey];
        if (isFolder) {
            const descendants = getDescendantPaths(nodeKey);
            const childrenStates = descendants.map(p => selectionState[p]).filter(state => state !== undefined);
            if (childrenStates.length > 0) {
                const allChecked = childrenStates.every(state => state === true);
                const noneChecked = childrenStates.every(state => state === false);
                if (allChecked) {
                    checkbox.checked = true;
                    checkbox.indeterminate = false;
                    selectionState[nodeKey] = true;
                } else if (noneChecked) {
                    checkbox.checked = false;
                    checkbox.indeterminate = false;
                    selectionState[nodeKey] = false;
                } else {
                    checkbox.checked = false;
                    checkbox.indeterminate = true;
                    selectionState[nodeKey] = false;
                }
            } else {
                 checkbox.checked = currentState === true;
                 checkbox.indeterminate = false;
                 selectionState[nodeKey] = checkbox.checked;
            }
        } else {
            checkbox.checked = currentState === true;
            checkbox.indeterminate = false;
        }

        const label = document.createElement('label');
        label.htmlFor = safeId;

        const hasChildren = isFolder && itemNode.__children && Object.keys(itemNode.__children).length > 0;
        const toggler = document.createElement('span');
        toggler.className = 'toggler';
        if (hasChildren) {
            toggler.textContent = '\u25B6'; // ▶ (Unicode escape)
            toggler.title = "Expand/Collapse";
        } else {
             toggler.innerHTML = ' '; // Keep alignment
             if(isFolder) li.classList.remove('collapsed');
        }
        label.appendChild(toggler);

        const icon = document.createElement('span');
        icon.className = 'node-icon';
        icon.textContent = isFolder ? '\u{1F4C1}' : '\u{1F4C4}'; // 📁 : 📄 (ES6 Unicode escapes)
        label.appendChild(icon);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'node-name';
        nameSpan.textContent = key;
        nameSpan.title = itemPath;
        label.appendChild(nameSpan);

        const metaSpan = document.createElement('span');
        metaSpan.className = 'node-meta';
        if (!isFolder && itemData.size != null) {
            metaSpan.textContent = formatBytes(itemData.size);
        }
        label.appendChild(metaSpan);

        li.appendChild(checkbox);
        li.appendChild(label);
        parentElement.appendChild(li);

        if (hasChildren) {
            const childrenUl = document.createElement('ul');
            childrenUl.className = 'tree-node-children';
            li.appendChild(childrenUl);
            createTreeNodesRecursive(itemNode.__children, childrenUl);
        }
    }
}

/** Adds event listeners to the dynamically generated tree using event delegation. */
function addTreeEventListeners() {
     console.log("[Popup] Adding tree event listeners...");
     fileTreeContainer.removeEventListener('change', handleCheckboxChange);
     fileTreeContainer.removeEventListener('click', handleTreeClick);
     fileTreeContainer.addEventListener('change', handleCheckboxChange);
     fileTreeContainer.addEventListener('click', handleTreeClick);
     console.log("[Popup] Tree event listeners added.");
}

// --- Event Handlers ---
/**
 * Handles checkbox changes in the file tree. Updates selection state,
 * propagates changes, persists state, and updates UI.
 * @param {Event} event - The change event object.
 */
async function handleCheckboxChange(event) {
    if (event.target.type !== 'checkbox' || !event.target.dataset.path) return;

    const checkbox = event.target;
    const pathKey = checkbox.dataset.path;
    const isChecked = checkbox.checked;

    console.log(`[Popup] Checkbox changed: ${pathKey}, New Checked State: ${isChecked}, Was Indeterminate: ${checkbox.indeterminate}`);

    if (checkbox.indeterminate) {
        checkbox.indeterminate = false;
    }

    selectionState[pathKey] = isChecked;

    const isFolder = pathKey.endsWith('/');
    if (isFolder) {
        const descendants = getDescendantPaths(pathKey);
        descendants.forEach(descendantPathKey => {
            if (selectionState[descendantPathKey] !== isChecked) {
                 selectionState[descendantPathKey] = isChecked;
            }
            const descendantCheckbox = fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(descendantPathKey)}"]`);
            if (descendantCheckbox) {
                descendantCheckbox.checked = isChecked;
                descendantCheckbox.indeterminate = false;
            }
        });
        console.log(`[Popup] Propagated check state (${isChecked}) to ${descendants.length} descendants of ${pathKey}`);
    }

    let parentPathKey = getParentFolderPath(pathKey);
    while (parentPathKey) {
        const parentCheckbox = fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(parentPathKey)}"]`);
        if (!parentCheckbox) {
             console.warn(`[Popup] Could not find parent checkbox DOM element for path: ${parentPathKey}`);
             break;
        }

        const directChildrenKeys = Object.keys(selectionState).filter(k => getParentFolderPath(k) === parentPathKey);

        if (directChildrenKeys.length === 0) {
             console.warn(`[Popup] Parent folder ${parentPathKey} has no tracked children. Assuming state based on checkbox.`);
             selectionState[parentPathKey] = parentCheckbox.checked;
             parentCheckbox.indeterminate = false;
        } else {
            const childrenStates = directChildrenKeys.map(k => ({ state: selectionState[k], checkbox: fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(k)}"]`) }));
            const allChecked = childrenStates.every(cs => cs.state === true && !cs.checkbox?.indeterminate);
            const noneChecked = childrenStates.every(cs => cs.state === false && !cs.checkbox?.indeterminate);
            const anyIndeterminate = childrenStates.some(cs => cs.checkbox?.indeterminate);

            if (anyIndeterminate || (!allChecked && !noneChecked)) {
                 selectionState[parentPathKey] = false;
                 parentCheckbox.checked = false;
                 parentCheckbox.indeterminate = true;
                 console.log(`[Popup] Parent folder ${parentPathKey} set to indeterminate.`);
            } else if (allChecked) {
                selectionState[parentPathKey] = true;
                parentCheckbox.checked = true;
                parentCheckbox.indeterminate = false;
                console.log(`[Popup] Parent folder ${parentPathKey} set to checked.`);
            } else {
                selectionState[parentPathKey] = false;
                parentCheckbox.checked = false;
                parentCheckbox.indeterminate = false;
                 console.log(`[Popup] Parent folder ${parentPathKey} set to unchecked.`);
            }
        }
        parentPathKey = getParentFolderPath(parentPathKey);
    }

    calculateSelectedTotals();
    updateSelectionInfo();

    try {
        console.log("[Popup] Persisting updated selection state...");
        const success = await setRepoSelectionState(currentRepoUrl, selectionState);
        if (!success) {
            console.error("[Popup] Failed to persist selection state.");
            showStatus("Warning: Could not save selection state.", true);
            setTimeout(clearMessages, 3000);
        } else {
             console.log("[Popup] Selection state persisted successfully.");
        }
    } catch (error) {
        console.error("[Popup] Error persisting selection state:", error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
         showStatus("Warning: Error saving selection state.", true);
         setTimeout(clearMessages, 3000);
    }
}


/**
 * Handles clicks within the tree container, specifically for toggling folders.
 * Uses Unicode escapes for icons.
 * @param {Event} event - The click event object.
 */
function handleTreeClick(event) {
    const toggler = event.target.closest('.toggler');
    if (toggler && toggler.parentElement.closest('.tree-node.folder')) {
        const nodeLi = toggler.closest('.tree-node.folder');
        const childrenUl = nodeLi.querySelector('.tree-node-children');

        if (nodeLi && childrenUl) {
             console.log(`[Popup] Toggler clicked for: ${nodeLi.dataset.path}`);
            const isCollapsed = nodeLi.classList.toggle('collapsed');
            toggler.textContent = isCollapsed ? '\u25B6' : '\u25BC'; // ▶ : ▼ (Unicode escapes)
        }
    }
}


// --- Action Button Handlers ---

/**
 * Fetches the context prefix string from the assets file.
 * Includes robust error handling.
 * @returns {Promise<string>} The prefix string (with trailing newlines) or an empty string if fetch fails.
 */
async function getContextPrefix() {
    const prefixFilePath = 'assets/context_prefix.txt';
    try {
        const prefixUrl = chrome.runtime.getURL(prefixFilePath);
        console.log(`[Popup] Fetching context prefix from: ${prefixUrl}`);
        const response = await fetch(prefixUrl);
        if (!response.ok) {
            // Log the status text for more context on the error
            throw new Error(`Failed to fetch prefix file at ${prefixFilePath}: ${response.status} ${response.statusText}`);
        }
        const prefixText = await response.text();
        console.log("[Popup] Successfully fetched context prefix.");
        // Ensure consistent formatting with trailing newlines
        return prefixText.trimEnd() + '\n\n';
    } catch (error) {
        console.error(`[Popup] Error fetching context prefix:`, error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
        // Display error to the user
        showError(`Error loading context prefix: ${error.message}. Check console and ensure '${prefixFilePath}' exists.`);
        return ""; // Return empty string on failure
    }
}


/** Handles the click on the "Copy Context" button. Fetches prefix and selected file contents. */
async function handleCopyClick() {
    console.log("[Popup] Copy button clicked.");
    if (copyButton.disabled) {
        console.warn("[Popup] Copy button clicked while disabled.");
        return;
    }

    disableControls();
    refreshButton.disabled = false; // Keep refresh active
    const originalButtonHTML = copyButton.innerHTML;
    copyButton.innerHTML = `<span class="icon"></span> Copying...`; // Update icon using HTML entity in JS temporarily
    clearMessages();
    showStatus("Preparing context...");

    // Fetch the prefix first
    const contextPrefix = await getContextPrefix();
    // No need to bail here if prefix fetch failed, getContextPrefix shows error and returns ""

    showStatus("Preparing list of files to fetch...");
    const selectedFilesToFetch = [];
    for (const pathKey in selectionState) {
        if (selectionState[pathKey] === true && !pathKey.endsWith('/')) {
            const fileData = fileTreeData.find(item => item.path === pathKey && item.type === 'blob');
            if (fileData && fileData.sha) {
                selectedFilesToFetch.push({ path: fileData.path, sha: fileData.sha });
            } else {
                 console.warn(`[Popup] Could not find SHA for selected file: ${pathKey}. Skipping.`);
            }
        }
    }

     console.log(`[Popup] Found ${selectedFilesToFetch.length} selected files with SHAs.`);

     if (selectedFilesToFetch.length === 0) {
         showError("No files selected to copy.");
         // Reset button HTML to original (which uses HTML entities now)
         copyButton.innerHTML = originalButtonHTML;
         copyButton.disabled = true;
         expandAllButton.disabled = fileTreeData.length === 0;
         collapseAllButton.disabled = fileTreeData.length === 0;
         refreshButton.disabled = false;
         return;
     }

    let formattedContext = "";
    let filesProcessed = 0;
    let fetchErrors = 0;
    const totalToFetch = selectedFilesToFetch.length;
    const startTime = performance.now();
    showStatus(`Fetching content for ${totalToFetch} files... (0/${totalToFetch})`);

    try {
        selectedFilesToFetch.sort((a, b) => a.path.localeCompare(b.path));

        const contentPromises = selectedFilesToFetch.map(file =>
            getFileContentBySha(currentOwner, currentRepo, file.sha)
                .then(content => {
                    filesProcessed++;
                    if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) {
                        showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    return { path: file.path, content: content };
                })
                .catch(error => {
                    console.error(`[Popup] Failed to fetch content for ${file.path} (SHA: ${file.sha}):`, error);
                    // Log stack trace for detailed debugging
                    console.error(error.stack);
                    fetchErrors++;
                    filesProcessed++;
                     if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) {
                        showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    return { path: file.path, error: error.message || "Unknown error" };
                })
        );

        const results = await Promise.all(contentPromises);
        const endTime = performance.now();
        console.log(`[Popup] Content fetching completed in ${((endTime - startTime) / 1000).toFixed(2)}s.`);

        showStatus("Formatting context...");

        results.forEach(result => {
            if (result.content !== undefined) {
                const sanitizedContent = result.content.replace(/\0/g, '');
                formattedContext += `// file path: ${result.path}\n`;
                formattedContext += `${sanitizedContent}\n\n`;
            } else {
                 console.warn(`[Popup] Skipping file in final output due to fetch error: ${result.path}`);
            }
        });

        formattedContext = formattedContext.trimEnd();

        const filesCopied = totalToFetch - fetchErrors;
        let finalMessage;
        let messageIsWarning = false;

        if (filesCopied > 0) {
            finalMessage = `Context for ${filesCopied} file(s) copied!`;
            if (fetchErrors > 0) {
                finalMessage += ` (${fetchErrors} failed)`;
                messageIsWarning = true;
            }
        } else if (fetchErrors > 0) {
            finalMessage = `Copy failed: Could not retrieve content for any of the ${fetchErrors} selected files.`;
            messageIsWarning = true;
        } else {
            finalMessage = "Copy failed: No content generated.";
            messageIsWarning = true;
        }

        // Only attempt copy if there's something to copy (prefix or formatted content)
        const fullContextToCopy = contextPrefix + formattedContext;
        if (fullContextToCopy.trim()) { // Check if the combined string is not empty/whitespace
             await navigator.clipboard.writeText(fullContextToCopy);
             console.log("[Popup] Formatted context with prefix copied to clipboard.");
             showStatus(finalMessage, messageIsWarning); // Show success/partial success
        } else {
             // Logged errors earlier (prefix fetch or all file fetches failed)
             console.log("[Popup] Nothing to copy to clipboard (prefix and content are empty).");
             // Ensure error message reflects the situation
             if (fetchErrors === totalToFetch && totalToFetch > 0) {
                 showError(finalMessage); // All file fetches failed
             } else if (!contextPrefix && selectedFilesToFetch.length === 0) {
                 showError("Copy failed: No prefix loaded and no files selected.");
             } else {
                 showError("Copy failed: Nothing generated to copy."); // Generic fallback
             }
        }

        // System notification
        try {
            const hasNotificationPermission = await chrome.permissions.contains({ permissions: ['notifications'] });
            if(hasNotificationPermission) {
                 chrome.notifications.create({
                     type: 'basic',
                     iconUrl: chrome.runtime.getURL('icons/icon48.png'),
                     title: 'GitHub AI Context Builder',
                     message: finalMessage
                 });
            } else {
                console.log("[Popup] Notification permission not granted, skipping notification.");
            }
        } catch (notifyError) {
             console.warn("[Popup] Could not create notification:", notifyError);
             console.warn(notifyError.stack); // Log stack trace
        }

    } catch (error) {
        console.error("[Popup] Error during copy process:", error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
        showError(`Copy failed unexpectedly: ${error.message}`);
    } finally {
        // Reset button HTML to original (which uses HTML entities now)
        copyButton.innerHTML = originalButtonHTML;
        // Re-enable buttons based on current state
        copyButton.disabled = totalSelectedFiles === 0;
        expandAllButton.disabled = fileTreeData.length === 0;
        collapseAllButton.disabled = fileTreeData.length === 0;
        refreshButton.disabled = false;
    }
}

/** Handles the click on the "Refresh" button. */
function handleRefreshClick() {
    console.log("[Popup] Refresh button clicked.");
    clearMessages();
    fileTreeContainer.innerHTML = '';
    repoTitleElement.textContent = "Refreshing...";
    disableControls();

    selectionState = {};
    fileTreeData = [];
    treeHierarchy = {};
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
    isTruncated = false;
    updateSelectionInfo();

    initializePopup();
}

/** Handles the click on the "Expand All" button. */
function handleExpandAll() {
    console.log("[Popup] Expand All clicked.");
    const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
    togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        if (nodeLi && nodeLi.querySelector('.tree-node-children') && nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.remove('collapsed');
            toggler.textContent = '\u25BC'; // ▼ (Unicode escape)
        }
    });
}

/** Handles the click on the "Collapse All" button. */
function handleCollapseAll() {
     console.log("[Popup] Collapse All clicked.");
     const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
     togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        if (nodeLi && nodeLi.querySelector('.tree-node-children') && !nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.add('collapsed');
            toggler.textContent = '\u25B6'; // ▶ (Unicode escape)
        }
    });
}


// --- Attach Event Listeners ---
document.addEventListener('DOMContentLoaded', initializePopup);
copyButton.addEventListener('click', handleCopyClick);
refreshButton.addEventListener('click', handleRefreshClick);
expandAllButton.addEventListener('click', handleExpandAll);
collapseAllButton.addEventListener('click', handleCollapseAll);
// Tree listeners are attached dynamically after render in addTreeEventListeners()

console.log("[Popup] Script loaded and ready.");