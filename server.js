require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const Razorpay = require('razorpay');
const { printDocument } = require('./services/printer');

// ==========================================
// CRASH PROTECTION (Prevents "Failed to fetch")
// ==========================================
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// SECURITY: Rate Limiting (simple in-memory)
// ==========================================
const requestCounts = {};
function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    if (!requestCounts[ip]) requestCounts[ip] = [];
    requestCounts[ip] = requestCounts[ip].filter(t => now - t < 60000);
    if (requestCounts[ip].length > 30) {
        return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
    requestCounts[ip].push(now);
    next();
}
app.use('/api/', rateLimiter);

// ==========================================
// SECURITY: Protect admin page with password
// ==========================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use('/admin.html', (req, res, next) => {
    next();
});

app.use('/api/admin/', (req, res, next) => {
    const password = req.headers['x-admin-password'] || req.query.password;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized. Invalid admin password.' });
    }
    next();
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// File upload with size limit (50MB max)
const upload = multer({
    dest: 'downloads/',
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF, JPG, and PNG files are allowed.'));
        }
    }
});

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Global store for print jobs & lifetime stats
global.printJobs = {};
global.shopStats = { revenue: 0, orders: 0, pages: 0 };

// Track used pickup codes
const usedCodes = new Set();
function generatePickupCode() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const numbers = "0123456789";
    let code;
    let attempts = 0;
    do {
        code = "";
        for (let i = 0; i < 2; i++) code += letters.charAt(Math.floor(Math.random() * letters.length));
        for (let i = 0; i < 2; i++) code += numbers.charAt(Math.floor(Math.random() * numbers.length));
        attempts++;
        if (attempts > 100) code += numbers.charAt(Math.floor(Math.random() * numbers.length));
    } while (usedCodes.has(code));
    
    usedCodes.add(code);
    return code;
}

// ==========================================
// 1. Upload File & Parse Pages
// ==========================================
app.post('/api/upload', upload.single('document'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let pageCount = 1;
    if (req.file.mimetype === 'application/pdf') {
        try {
            const dataBuffer = fs.readFileSync(req.file.path);
            const data = await pdfParse(dataBuffer, { max: 1 });
            pageCount = data.numpages || 1;
        } catch (e) {
            console.error("Error parsing PDF pages:", e.message);
        }
    }

    const tempId = crypto.randomBytes(8).toString('hex');
    global.printJobs[tempId] = {
        tempId,
        filePath: req.file.path,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        pageCount,
        status: 'uploaded_not_paid',
        timestamp: new Date().toISOString()
    };

    res.json({ tempId, pageCount, fileName: req.file.originalname });
});

// ==========================================
// 2. Create Payment Order
// ==========================================
app.post('/api/create-order', async (req, res) => {
    const { tempId, colorMode, paperSize, copies, sides } = req.body;
    const job = global.printJobs[tempId];

    if (!job) return res.status(404).json({ error: 'Document session expired. Please upload again.' });
    if (job.razorpayOrderId) return res.status(400).json({ error: 'Payment already created.' });

    const pricePerPage = colorMode === 'color' ? 10 : 2;
    const totalCopies = Math.min(Math.max(parseInt(copies) || 1, 1), 50);
    const totalAmount = job.pageCount * pricePerPage * totalCopies;

    if (totalAmount < 1) return res.status(400).json({ error: 'Invalid amount calculated.' });

    job.settings = { colorMode, paperSize, copies: totalCopies, sides };
    job.totalAmount = totalAmount;

    try {
        const order = await razorpay.orders.create({
            amount: totalAmount * 100,
            currency: "INR",
            receipt: "rcpt_" + tempId.substring(0, 12)
        });

        job.razorpayOrderId = order.id;
        global.printJobs[order.id] = job;

        res.json({
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key: process.env.RAZORPAY_KEY_ID
        });
    } catch (err) {
        console.error("Razorpay error:", err.message);
        res.status(500).json({ error: 'Failed to create payment order.' });
    }
});

// ==========================================
// 3. Verify Payment & Update Stats
// ==========================================
app.post('/api/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Missing payment details.' });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body.toString())
        .digest('hex');

    if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Invalid signature.' });
    }

    const job = global.printJobs[razorpay_order_id];
    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });
    if (job.pickupCode) return res.json({ success: true, pickupCode: job.pickupCode });

    job.status = 'paid_and_printing';
    job.pickupCode = generatePickupCode();
    job.paymentId = razorpay_payment_id;
    job.paidAt = new Date().toISOString();

    // Update shop statistics
    global.shopStats.revenue += job.totalAmount;
    global.shopStats.orders += 1;
    global.shopStats.pages += (job.pageCount * job.settings.copies);

    console.log(`✅ Paid! Code: ${job.pickupCode} | ₹${job.totalAmount}`);

    printDocument(job.filePath).then(success => {
        job.status = success ? 'printing_completed' : 'print_queued';
    });

    res.json({ success: true, pickupCode: job.pickupCode });
});

// ==========================================
// 4. Admin API: Dashboard Data
// ==========================================
app.get('/api/admin/orders', (req, res) => {
    const activeOrders = Object.values(global.printJobs)
        .filter(job => job.pickupCode)
        .filter((job, index, self) => index === self.findIndex(j => j.pickupCode === job.pickupCode))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
        stats: global.shopStats,
        orders: activeOrders
    });
});

// ==========================================
// 5. Admin API: Mark collected
// ==========================================
app.post('/api/admin/mark-collected', (req, res) => {
    const { pickupCode } = req.body;
    const job = Object.values(global.printJobs).find(j => j.pickupCode === pickupCode);
    if (job) {
        job.status = 'collected';
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Order not found.' });
    }
});

// ==========================================
// 6. Admin API: Manual Reprint
// ==========================================
app.post('/api/admin/reprint', (req, res) => {
    const { pickupCode } = req.body;
    const job = Object.values(global.printJobs).find(j => j.pickupCode === pickupCode);
    if (job) {
        printDocument(job.filePath).then(success => {
            job.status = success ? 'printing_completed' : 'print_queued';
        });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Order not found.' });
    }
});

// Error handler
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Max 50MB.' });
    }
    if (err.message) return res.status(400).json({ error: err.message });
    next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🌐 Customer Portal: http://localhost:${PORT}`);
    console.log(`⚙️  Admin Dashboard: http://localhost:${PORT}/admin.html`);
    console.log(`🔑 Admin Password:  ${ADMIN_PASSWORD}`);
    console.log(`=========================================`);
});
