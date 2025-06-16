const REGISTRY_URL = 'https://raw.githubusercontent.com/rickoneeleven/extension-versions/main/versions.json';
const EXTENSION_ID = 'github-ai-context-builder';

export async function initVersionChecker() {
    console.log('[popup_version] Initializing version checker UI');
    
    // Auto-check if it's been >24 hours since last check (every popup open)
    console.log('[popup_version] Checking if auto-check needed on popup open');
    if (await shouldCheck()) {
        console.log('[popup_version] Auto-triggering version check (>24 hours since last check)');
        await performVersionCheck(true, false);
    } else {
        console.log('[popup_version] Skipping auto-check (checked recently)');
    }
    
    // Set up check now button
    const checkButton = document.getElementById('check-updates-button');
    if (checkButton) {
        checkButton.addEventListener('click', handleCheckNow);
    }
    
    // Set up test badge button
    const testBadgeButton = document.getElementById('test-badge-button');
    if (testBadgeButton) {
        testBadgeButton.addEventListener('click', handleTestBadge);
    }
    
    // Initial display update
    await updateVersionDisplay();
    
    // Update display every 30 seconds to refresh "X minutes ago" text
    setInterval(updateVersionDisplay, 30000);
}

async function shouldCheck() {
    const result = await chrome.storage.local.get(['lastVersionCheck']);
    const lastCheck = result.lastVersionCheck;
    
    if (!lastCheck || !lastCheck.time) return true;
    
    const hoursSinceLastCheck = (Date.now() - lastCheck.time) / (1000 * 60 * 60);
    return hoursSinceLastCheck >= 24;
}

async function updateVersionDisplay() {
    const manifest = chrome.runtime.getManifest();
    const currentVersion = manifest.version;
    
    const result = await chrome.storage.local.get(['latestVersion', 'lastVersionCheck']);
    
    // Update current version
    document.getElementById('current-version').textContent = currentVersion;
    
    // Update latest version (use cached data for display updates)
    const latestVersion = result.latestVersion || '-';
    document.getElementById('latest-version').textContent = latestVersion;
    
    // Update last checked time
    let lastCheckedText = 'Never';
    if (result.lastVersionCheck && result.lastVersionCheck.time) {
        lastCheckedText = formatLastChecked(result.lastVersionCheck.time);
    }
    document.getElementById('last-checked').textContent = lastCheckedText;
    
    // Style latest version if update available
    if (latestVersion !== '-' && compareVersions(latestVersion, currentVersion) > 0) {
        document.getElementById('latest-version').style.color = '#28a745';
        document.getElementById('latest-version').style.fontWeight = 'bold';
    } else {
        document.getElementById('latest-version').style.color = '';
        document.getElementById('latest-version').style.fontWeight = '';
    }
}

async function handleTestBadge() {
    console.log('[popup_version] Test badge button clicked');
    chrome.runtime.sendMessage({ action: 'setBadge', show: true }, (response) => {
        console.log('[popup_version] Badge test response:', response);
    });
}

async function handleCheckNow() {
    console.log('[popup_version] Check now button clicked - FORCING check (bypass rate limit)');
    await performVersionCheck(false, true); // Add force parameter
}

async function performVersionCheck(isAutoCheck = false, forceCheck = false) {
    const button = document.getElementById('check-updates-button');
    
    if (!isAutoCheck) {
        button.disabled = true;
        button.textContent = 'Checking...';
    }
    
    try {
        console.log(`[popup_version] ${isAutoCheck ? 'Auto-checking' : 'Manual checking'} for updates`);
        console.log('[popup_version] Fetching from URL:', REGISTRY_URL);
        console.log('[popup_version] Looking for extension ID:', EXTENSION_ID);
        
        // Add cache-busting for manual/forced checks to ensure fresh data
        const fetchUrl = (forceCheck || !isAutoCheck) ? `${REGISTRY_URL}?t=${Date.now()}` : REGISTRY_URL;
        console.log('[popup_version] Actual fetch URL:', fetchUrl);
        console.log('[popup_version] Force check mode:', forceCheck);
        
        const response = await fetch(fetchUrl, {
            cache: (forceCheck || !isAutoCheck) ? 'no-cache' : 'default'
        });
        console.log('[popup_version] Fetch response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const responseText = await response.text();
        console.log('[popup_version] Raw response text:', responseText);
        
        const data = JSON.parse(responseText);
        console.log('[popup_version] Parsed JSON data:', data);
        
        const latestVersion = data[EXTENSION_ID];
        console.log('[popup_version] Latest version found:', latestVersion);
        
        if (latestVersion) {
            const now = Date.now();
            
            chrome.storage.local.set({
                latestVersion: latestVersion,
                lastVersionCheck: { time: now, version: latestVersion }
            });
            
            // Update display immediately after storage update
            if (!isAutoCheck) {
                await updateVersionDisplay();
            }
            
            const manifest = chrome.runtime.getManifest();
            const currentVersion = manifest.version;
            console.log('[popup_version] Current version:', currentVersion, 'Latest version:', latestVersion);
            
            if (compareVersions(latestVersion, currentVersion) > 0) {
                console.log('[popup_version] Update available!');
                document.getElementById('latest-version').style.color = '#28a745';
                document.getElementById('latest-version').style.fontWeight = 'bold';
                
                if (!isAutoCheck) {
                    chrome.notifications.create('manual-version-check', {
                        type: 'basic',
                        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
                        title: 'Update Available',
                        message: `Version ${latestVersion} is available (current: ${currentVersion})`,
                        priority: 1
                    });
                }
            } else {
                console.log('[popup_version] Extension is up to date');
            }
        } else {
            console.log('[popup_version] Extension not found in registry');
            document.getElementById('latest-version').textContent = 'Not found';
        }
    } catch (error) {
        console.error('[popup_version] Error checking for updates:', error);
        console.error('[popup_version] Error details:', {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        document.getElementById('latest-version').textContent = 'Error';
    } finally {
        if (!isAutoCheck) {
            button.disabled = false;
            button.textContent = 'Check now';
        }
    }
}

function formatLastChecked(timestamp) {
    const now = new Date();
    const checkTime = new Date(timestamp);
    const diffMinutes = Math.floor((now - checkTime) / (1000 * 60));
    
    if (diffMinutes < 1) {
        return 'Just now';
    } else if (diffMinutes < 60) {
        return `${diffMinutes}m ago`;
    } else if (diffMinutes < 1440) {
        const hours = Math.floor(diffMinutes / 60);
        return `${hours}h ago`;
    } else {
        const days = Math.floor(diffMinutes / 1440);
        return `${days}d ago`;
    }
}

function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const part1 = parts1[i] || 0;
        const part2 = parts2[i] || 0;
        if (part1 > part2) return 1;
        if (part1 < part2) return -1;
    }
    return 0;
}

// Debug function to clear cached version data (for testing)
window.clearVersionCache = function() {
    chrome.storage.local.remove(['latestVersion', 'lastVersionCheck'], () => {
        console.log('[popup_version] DEBUG: Version cache cleared');
        updateVersionDisplay();
    });
};

// Debug function to force badge update based on current version status
window.testBadge = async function() {
    console.log('[popup_version] DEBUG: Testing badge functionality');
    const manifest = chrome.runtime.getManifest();
    const currentVersion = manifest.version;
    const result = await chrome.storage.local.get(['latestVersion']);
    const latestVersion = result.latestVersion;
    
    console.log(`Current: ${currentVersion}, Latest: ${latestVersion}`);
    
    if (latestVersion && compareVersions(latestVersion, currentVersion) > 0) {
        console.log('[popup_version] DEBUG: Setting badge for available update');
        chrome.runtime.sendMessage({ action: 'setBadge', show: true });
    } else {
        console.log('[popup_version] DEBUG: Clearing badge (up to date)');
        chrome.runtime.sendMessage({ action: 'setBadge', show: false });
    }
};

// Debug function to manually trigger background version check
window.forceVersionCheck = function() {
    console.log('[popup_version] DEBUG: Forcing background version check');
    chrome.runtime.sendMessage({ action: 'forceVersionCheck' });
};