import { initVersionChecker, checkForUpdates } from './common/version-checker.js';

console.log('Background service worker starting...');

initVersionChecker().then(() => {
    console.log('Version checker initialized');
}).catch(error => {
    console.error('Failed to initialize version checker:', error);
});

chrome.runtime.onInstalled.addListener((details) => {
    console.log('Extension installed/updated', details);
});

chrome.runtime.onStartup.addListener(() => {
    console.log('Browser started');
});

// Handle messages from popup for debug functions
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', message);
    
    if (message.action === 'setBadge') {
        if (message.show) {
            chrome.action.setBadgeText({ text: '!' });
            chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
            console.log('Badge set via message');
        } else {
            chrome.action.setBadgeText({ text: '' });
            console.log('Badge cleared via message');
        }
        sendResponse({ success: true });
    } else if (message.action === 'forceVersionCheck') {
        checkForUpdates(true).then(() => {
            console.log('Forced version check completed');
            sendResponse({ success: true });
        }).catch(error => {
            console.error('Forced version check failed:', error);
            sendResponse({ success: false, error: error.message });
        });
        return true; // Keep message channel open for async response
    }
});

// Test change to trigger atomic versioning workflow - 2025-06-16