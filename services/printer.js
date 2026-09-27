const { exec } = require('child_process');
const os = require('os');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

/**
 * Send the downloaded document to the default local printer on Windows
 */
async function printDocument(filePath, pickupCode) {
    if (os.platform() !== 'win32') {
        console.log('Printing feature currently configured for Windows OS only.');
        return false;
    }

    try {
        let printPath = path.resolve(filePath);

        // If we have a pickup code, create a label and merge it
        if (pickupCode) {
            try {
                const labelDoc = await PDFDocument.create();
                const page = labelDoc.addPage([595, 28]); // A4 width, ~1 cm height
                const font = await labelDoc.embedFont(StandardFonts.HelveticaBold);
                const fontSize = 12;
                const text = `Pickup Code: ${pickupCode}`;
                const textWidth = font.widthOfTextAtSize(text, fontSize);
                page.drawText(text, {
                    x: (page.getWidth() - textWidth) / 2,
                    y: (page.getHeight() - fontSize) / 2,
                    size: fontSize,
                    font,
                    color: rgb(0, 0, 0),
                });
                const labelBytes = await labelDoc.save();

                // Merge label with user PDF
                const mergedPath = path.join(path.dirname(filePath), `merged-${Date.now()}.pdf`);
                if (path.extname(filePath).toLowerCase() === '.pdf') {
                    const userBytes = await fs.promises.readFile(filePath);
                    const mergedPdf = await PDFDocument.create();
                    const labelPdf = await PDFDocument.load(labelBytes);
                    const userPdf = await PDFDocument.load(userBytes);
                    const [labelPage] = await mergedPdf.copyPages(labelPdf, [0]);
                    mergedPdf.addPage(labelPage);
                    const userPages = await mergedPdf.copyPages(userPdf, userPdf.getPageIndices());
                    userPages.forEach(p => mergedPdf.addPage(p));
                    const finalBytes = await mergedPdf.save();
                    await fs.promises.writeFile(mergedPath, finalBytes);
                } else {
                    await fs.promises.writeFile(mergedPath, labelBytes);
                }
                printPath = path.resolve(mergedPath);
            } catch (labelErr) {
                console.error('Label generation failed, printing original file:', labelErr.message);
                // Fall through to print the original file without label
            }
        }

        // Use Adobe Reader for silent printing (works reliably on Windows)
        const adobePath = 'C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe';
        
        return new Promise((resolve) => {
            let command;
            if (fs.existsSync(adobePath) && printPath.toLowerCase().endsWith('.pdf')) {
                // Adobe Reader silent print: /t = print to default printer, /h = minimize
                command = `& '${adobePath}' /t "${printPath}"`;
            } else {
                // Fallback: use rundll32 which handles file associations better
                command = `rundll32.exe mshtml.dll,PrintHTML "${printPath}"`;
            }

            const psCommand = `powershell -Command "${command.replace(/"/g, '\\"')}"`;
            console.log(`🖨️ Sending to printer: ${path.basename(printPath)}`);
            
            exec(psCommand, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Print error: ${error.message}`);
                    // Try alternative method
                    const fallback = `powershell -Command "Start-Process -FilePath '${printPath}' -Verb PrintTo -ArgumentList '\\\\localhost\\default'"`;
                    exec(fallback, { timeout: 30000 }, (err2) => {
                        if (err2) {
                            console.error(`Fallback print also failed: ${err2.message}`);
                        }
                        resolve(true);
                    });
                } else {
                    console.log('🖨️ Print job sent successfully!');
                    resolve(true);
                }
            });
        });
    } catch (e) {
        console.error('Unexpected error in printDocument:', e);
        return true;
    }
}

module.exports = { printDocument };
