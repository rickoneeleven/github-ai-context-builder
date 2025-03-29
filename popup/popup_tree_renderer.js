// File: popup/popup_tree_renderer.js
import { log, formatBytes, getItemPathKey } from './popup_utils.js'; // Import necessary utils

console.log("[Popup Tree Renderer] Module loading...");

// --- Constants for Tree Rendering ---
const COLLAPSED_ICON = '\u25B6'; // ►
const EXPANDED_ICON = '\u25BC'; // ▼
const FOLDER_ICON = '\u{1F4C1}'; // 📁
const FILE_ICON = '\u{1F4C4}'; // 📄

// --- Private Helper Functions ---

/**
 * Builds the hierarchical tree structure from the flat API data.
 * This version is intended to be internal to the renderer module.
 * @param {Array<object>} items - The flat list of file tree items from the API.
 * @returns {object} A nested object representing the file tree hierarchy.
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
                // Create node if it doesn't exist
                currentLevel[part] = {
                    __data: isLastPart ? item : { path: currentPathSegment, type: 'tree' }, // Simplified placeholder
                    __children: item.type === 'tree' ? {} : null
                };
                if (!isLastPart && currentLevel[part].__children === null) {
                    currentLevel[part].__children = {}; // Ensure intermediate nodes are folders
                }
            } else {
                // Node exists, update data if this is the final item
                if (isLastPart) {
                    currentLevel[part].__data = item;
                    // Correct __children based on final type
                    if (item.type === 'tree' && !currentLevel[part].__children) {
                         currentLevel[part].__children = {};
                    } else if (item.type === 'blob') {
                         currentLevel[part].__children = null;
                    }
                }
                // Ensure intermediate nodes have children object
                else if (!currentLevel[part].__children) {
                    currentLevel[part].__children = {};
                     // Ensure data reflects it's an intermediate folder if needed
                     if (!currentLevel[part].__data || currentLevel[part].__data.type !== 'tree') {
                         currentLevel[part].__data = { ...(currentLevel[part].__data || {}), path: currentPathSegment, type: 'tree' };
                     }
                }
            }

            // Move down the hierarchy
            if (currentLevel[part] && currentLevel[part].__children) {
                currentLevel = currentLevel[part].__children;
            } else if (!isLastPart) {
                log('error', `[Tree Renderer] Tree building error: Expected folder at '${part}' for path '${item.path}'. Node:`, currentLevel[part]);
                break; // Stop processing this problematic path
            }
        }
    }
    return tree;
}

/**
 * Recursively creates HTML elements for the file tree nodes.
 * @param {object} node - Current level in the treeHierarchy.
 * @param {HTMLElement} parentElement - The parent UL element to append to.
 * @param {object} selectionState - The current selection state map { [pathKey]: boolean }.
 * @param {Function} updateFolderCheckboxStateCallback - Callback to determine initial folder state.
 */
function createTreeNodesRecursive(node, parentElement, selectionState, updateFolderCheckboxStateCallback) {
    // Sort keys: folders first, then files, alphabetically within type
    const keys = Object.keys(node).sort((a, b) => {
        const nodeA = node[a];
        const nodeB = node[b];
        const typeA = nodeA?.__data?.type === 'tree' ? 0 : 1;
        const typeB = nodeB?.__data?.type === 'tree' ? 0 : 1;
        if (typeA !== typeB) return typeA - typeB;
        return a.localeCompare(b);
    });

    for (const key of keys) {
        const itemNode = node[key];
        if (!itemNode || !itemNode.__data) {
             log('warn', `[Tree Renderer] Skipping node render, missing __data for key: ${key}`);
             continue;
        }
        const itemData = itemNode.__data;
        const isFolder = itemData.type === 'tree';
        const nodeKey = getItemPathKey(itemData); // Use util helper

        // --- Create List Item (LI) ---
        const li = document.createElement('li');
        li.className = `tree-node ${isFolder ? 'folder' : 'file'}`;
        li.dataset.path = nodeKey; // Store the canonical path key

        // --- Create Content Row (DIV) ---
        const nodeContentRow = document.createElement('div');
        nodeContentRow.className = 'tree-node-content';
        // Removed inline styles, assuming they are in popup.css

        // --- Checkbox ---
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const safeId = `cb_${nodeKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        checkbox.id = safeId;
        checkbox.dataset.path = nodeKey; // Reference path key
        // Set initial checked state based on provided selectionState
        checkbox.checked = !!selectionState[nodeKey];
        checkbox.indeterminate = false; // Initial state, folder logic will update if needed
        // Removed inline styles

        // --- Toggler (for folders) ---
        const toggler = document.createElement('span');
        toggler.className = 'toggler';
        const hasChildren = isFolder && itemNode.__children && Object.keys(itemNode.__children).length > 0;

        if (hasChildren) {
            toggler.textContent = COLLAPSED_ICON;
            toggler.title = "Expand/Collapse";
            li.classList.add('collapsed'); // Start collapsed if it has children
        } else {
            // Non-interactive placeholder for alignment
            toggler.innerHTML = ' '; // Use space for alignment
            toggler.style.cursor = 'default'; // Indicate non-interactive
            // Ensure empty folders aren't visually marked as collapsible
             if(isFolder) li.classList.remove('collapsed');
        }
        // Removed inline styles

        // --- Label (Container for icon, name, meta) ---
        const label = document.createElement('label');
        label.htmlFor = safeId; // Associate label with checkbox
        // Removed inline styles

        // --- Icon ---
        const icon = document.createElement('span');
        icon.className = 'node-icon';
        icon.textContent = isFolder ? FOLDER_ICON : FILE_ICON;
        // Removed inline styles

        // --- Name ---
        const nameSpan = document.createElement('span');
        nameSpan.className = 'node-name';
        nameSpan.textContent = key; // Display the base name (part)
        nameSpan.title = itemData.path; // Full path in tooltip
        // Removed inline styles

        // --- Metadata (Size) ---
        const metaSpan = document.createElement('span');
        metaSpan.className = 'node-meta';
        if (!isFolder && typeof itemData.size === 'number') { // Check type for safety
            metaSpan.textContent = formatBytes(itemData.size);
        }
        // Removed inline styles

        // --- Assemble Label ---
        label.appendChild(icon);
        label.appendChild(nameSpan);
        label.appendChild(metaSpan);

        // --- Assemble Content Row ---
        nodeContentRow.appendChild(checkbox);
        nodeContentRow.appendChild(toggler);
        nodeContentRow.appendChild(label);

        // --- Assemble List Item (LI) ---
        li.appendChild(nodeContentRow);
        parentElement.appendChild(li); // Add to parent UL

        // --- Determine Folder Checkbox State (Needs callback) ---
        // This needs to happen *after* the element is created but *before* recursing,
        // as children states depend on parent states sometimes.
        // However, the *logic* of determining this (checking children) belongs in tree_logic.js.
        // Renderer only sets the *initial* state based on the provided selectionState.
        // We pass a callback to let the logic module finalize the state if needed *after* rendering.
        if (isFolder && typeof updateFolderCheckboxStateCallback === 'function') {
            updateFolderCheckboxStateCallback(checkbox, nodeKey);
        }

        // --- Recurse for Children ---
        if (hasChildren) {
            const childrenUl = document.createElement('ul');
            childrenUl.className = 'tree-node-children';
            // Removed inline styles
            li.appendChild(childrenUl); // Append children UL to the current LI
            // Pass selectionState and callback down
            createTreeNodesRecursive(itemNode.__children, childrenUl, selectionState, updateFolderCheckboxStateCallback);
        }
    }
}

// --- Public Rendering Function ---

/**
 * Renders the entire file tree DOM structure.
 * Clears the container, builds the hierarchy, and creates the nodes.
 * @param {HTMLElement} fileTreeContainer - The container element to render into.
 * @param {Array<object>} fileTreeData - The flat list of file/folder items.
 * @param {object} selectionState - The current selection state { [pathKey]: boolean }.
 * @param {Function} updateFolderCheckboxStateCallback - Callback function from tree_logic to update folder states.
 */
function renderTreeDOM(fileTreeContainer, fileTreeData, selectionState, updateFolderCheckboxStateCallback) {
    log('info', "[Tree Renderer] Rendering file tree DOM...");
    if (!fileTreeContainer) {
        log('error', "[Tree Renderer] File tree container element not provided.");
        return;
    }
     if (!Array.isArray(fileTreeData)) {
         log('error', "[Tree Renderer] Invalid fileTreeData provided.");
         fileTreeContainer.innerHTML = '<div class="error">Error: Invalid file data.</div>';
         return;
     }
     if (typeof selectionState !== 'object' || selectionState === null) {
         log('error', "[Tree Renderer] Invalid selectionState provided.");
         fileTreeContainer.innerHTML = '<div class="error">Error: Invalid selection state.</div>';
         return;
     }
     if (typeof updateFolderCheckboxStateCallback !== 'function') {
         log('error', "[Tree Renderer] Invalid updateFolderCheckboxStateCallback provided.");
          fileTreeContainer.innerHTML = '<div class="error">Error: Tree logic callback missing.</div>';
         return;
     }


    const startTime = performance.now();
    fileTreeContainer.innerHTML = ''; // Clear previous content

    try {
        const treeHierarchy = buildTreeHierarchy(fileTreeData);

        const rootElement = document.createElement('ul');
        rootElement.className = 'tree-root';
        // Removed inline styles

        // Start recursion from the root level
        createTreeNodesRecursive(treeHierarchy, rootElement, selectionState, updateFolderCheckboxStateCallback);

        fileTreeContainer.appendChild(rootElement);
        const endTime = performance.now();
        log('info', `[Tree Renderer] File tree DOM rendering complete in ${((endTime - startTime)).toFixed(1)}ms.`);

    } catch (error) {
         log('error', "[Tree Renderer] Error during file tree DOM rendering:", error);
         showError(`Failed to render file tree: ${error.message}`); // Use showError from ui module? Or pass callback? For now, log only.
         fileTreeContainer.innerHTML = '<div class="error">Failed to display file tree. Check console.</div>';
    }
}


export {
    renderTreeDOM
};

console.log("[Popup Tree Renderer] Module loaded.");