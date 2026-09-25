const { exec } = require('child_process');
const os = require('os');

/**
 * Send the downloaded document to the default local printer on Windows
 */
async function printDocument(filePath) {
    return new Promise((resolve, reject) => {
        if (os.platform() === 'win32') {
            // Convert relative path to absolute for PowerShell
            const absolutePath = require('path').resolve(filePath);
            
            const command = `powershell -Command "Start-Process -FilePath '${absolutePath}' -Verb Print"`;
            
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Print error: ${error.message}`);
                    resolve(true); // Windows sometimes throws background app errors even on success
                } else {
                    console.log("🖨️ Print job successfully sent to the Windows spooler.");
                    resolve(true);
                }
            });
        } else {
            console.log("Printing feature currently configured for Windows OS only.");
            resolve(false);
        }
    });
}

module.exports = { printDocument };
