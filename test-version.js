import { generateTimestampVersion } from './update-version.js';

function testVersionGeneration() {
    console.log('Testing version generation...');
    
    const version1 = generateTimestampVersion();
    console.log(`Generated version 1: ${version1}`);
    
    setTimeout(() => {
        const version2 = generateTimestampVersion();
        console.log(`Generated version 2: ${version2}`);
        
        const versionRegex = /^\d{2}\.\d{2}\.\d{2}\.\d{4}$/;
        
        if (!versionRegex.test(version1)) {
            console.error(`Version 1 format invalid: ${version1}`);
            process.exit(1);
        }
        
        if (!versionRegex.test(version2)) {
            console.error(`Version 2 format invalid: ${version2}`);
            process.exit(1);
        }
        
        console.log('✓ Version format validation passed');
        
        const parts1 = version1.split('.');
        const parts2 = version2.split('.');
        const timestamp1 = parseInt(parts1[0] + parts1[1] + parts1[2] + parts1[3]);
        const timestamp2 = parseInt(parts2[0] + parts2[1] + parts2[2] + parts2[3]);
        
        if (timestamp2 <= timestamp1 && version1 !== version2) {
            console.error('Version 2 should be greater than version 1 if generated later');
            process.exit(1);
        }
        
        console.log('✓ Version ordering validation passed');
        console.log('All tests passed!');
    }, 100);
}

testVersionGeneration();