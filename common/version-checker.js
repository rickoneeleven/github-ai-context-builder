const REGISTRY_URL = 'https://raw.githubusercontent.com/rickoneeleven/extension-versions/main/versions.json';
const EXTENSION_ID = 'github-ai-context-builder';
const CHECK_INTERVAL_MS = 1000 * 60 * 60;
const NOTIFICATION_ID = 'version-update-available';

let lastCheckTime = 0;

async function getRemoteVersion() {
    try {
        const response = await fetch(REGISTRY_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data[EXTENSION_ID];
    } catch (error) {
        console.error('Error fetching remote version:', error);
        return null;
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

export async function checkForUpdates(forceCheck = false) {
    const now = Date.now();
    
    if (!forceCheck && (now - lastCheckTime) < CHECK_INTERVAL_MS) {
        console.log('Version check skipped - too soon since last check');
        return;
    }
    
    lastCheckTime = now;
    
    try {
        const manifest = chrome.runtime.getManifest();
        const currentVersion = manifest.version;
        const remoteVersion = await getRemoteVersion();
        
        if (!remoteVersion) {
            console.log('Could not fetch remote version');
            return;
        }
        
        console.log(`Current version: ${currentVersion}, Remote version: ${remoteVersion}`);
        
        if (compareVersions(remoteVersion, currentVersion) > 0) {
            console.log('Update available!');
            showUpdateNotification(currentVersion, remoteVersion);
        } else {
            console.log('Extension is up to date');
        }
    } catch (error) {
        console.error('Error checking for updates:', error);
    }
}

function showUpdateNotification(currentVersion, newVersion) {
    chrome.notifications.create(NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Update Available',
        message: `GitHub AI Context Builder ${newVersion} is available (current: ${currentVersion})`,
        priority: 1,
        buttons: [
            { title: 'View on GitHub' }
        ]
    });
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    if (notificationId === NOTIFICATION_ID && buttonIndex === 0) {
        chrome.tabs.create({ url: 'https://github.com/rickoneeleven/github-ai-context-builder/releases' });
    }
});

export async function initVersionChecker() {
    await checkForUpdates(true);
    
    setInterval(() => {
        checkForUpdates();
    }, CHECK_INTERVAL_MS);
    
    chrome.runtime.onStartup.addListener(() => {
        checkForUpdates(true);
    });
    
    chrome.runtime.onInstalled.addListener(() => {
        checkForUpdates(true);
    });
}