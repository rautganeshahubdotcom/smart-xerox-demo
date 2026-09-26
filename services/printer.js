const { exec } = require('child_process');
const os = require('os');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

/**
 * Send the downloaded document to the default local printer on Windows
 */
async function printDocument(filePath, pickupCode) {
    return new Promise(async (resolve, reject) => {
        if (os.platform() !== 'win32') {
            console.log('Printing feature currently configured for Windows OS only.');
            return resolve(false);
        }
        try {
            // 1️⃣ Create tiny label PDF (≈1 cm tall) with pickup code
            const pdfDoc = await PDFDocument.create();
            const page = pdfDoc.addPage([595, 28]); // A4 width, ~1 cm height at 72 dpi
            const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
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
            const labelBytes = await pdfDoc.save();

            // 2️⃣ Merge label with user document (if PDF) or print label then original file
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
                // Non‑PDF (image) – print the label first, then the original file
                await fs.promises.writeFile(mergedPath, labelBytes);
            }

            // 3️⃣ Send merged file to Windows spooler
            const absolutePath = path.resolve(mergedPath);
            const command = `powershell -Command "Start-Process -FilePath '${absolutePath}' -Verb Print"`;
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Print error: ${error.message}`);
                    resolve(true);
                } else {
                    console.log('🖨️ Print job (with pickup label) sent to the Windows spooler.');
                    resolve(true);
                }
            });
        } catch (e) {
            console.error('Unexpected error in printDocument:', e);
            resolve(true);
        }
    });
}

module.exports = { printDocument };
