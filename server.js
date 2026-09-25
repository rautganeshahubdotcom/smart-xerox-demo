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

// Ensure downloads directory exists for cloud deployments
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)){
    fs.mkdirSync(downloadsDir);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'downloads/' });

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

global.printJobs = {};

function generatePickupCode() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const numbers = "0123456789";
    let code = "";
    for(let i=0; i<2; i++) code += letters.charAt(Math.floor(Math.random() * letters.length));
    for(let i=0; i<2; i++) code += numbers.charAt(Math.floor(Math.random() * numbers.length));
    return code;
}

app.post('/api/upload', upload.single('document'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    let pageCount = 1; 
    
    if (req.file.mimetype === 'application/pdf') {
        try {
            const dataBuffer = fs.readFileSync(req.file.path);
            const data = await pdfParse(dataBuffer);
            pageCount = data.numpages;
        } catch (e) {
            console.error("Error parsing PDF pages:", e);
        }
    }

    const tempId = Date.now().toString(); 
    
    global.printJobs[tempId] = {
        tempId: tempId,
        filePath: req.file.path,
        originalName: req.file.originalname,
        pageCount: pageCount,
        status: 'uploaded_not_paid',
        timestamp: new Date().toISOString()
    };

    res.json({ tempId, pageCount, fileName: req.file.originalname });
});

app.post('/api/create-order', async (req, res) => {
    const { tempId, colorMode, paperSize, copies } = req.body;
    const job = global.printJobs[tempId];
    
    if (!job) return res.status(404).json({error: 'Document session expired. Please upload again.'});

    const pricePerPage = colorMode === 'color' ? 10 : 2;
    const totalCopies = parseInt(copies) || 1;
    const totalAmount = job.pageCount * pricePerPage * totalCopies;

    job.settings = { colorMode, paperSize, copies: totalCopies };
    job.totalAmount = totalAmount;

    try {
        const order = await razorpay.orders.create({
            amount: totalAmount * 100,
            currency: "INR",
            receipt: "receipt_" + tempId
        });

        job.razorpayOrderId = order.id;
        global.printJobs[order.id] = job;

        res.json({
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key: process.env.RAZORPAY_KEY_ID
        });
    } catch(err) {
        console.error("Razorpay error:", err);
        res.status(500).json({error: 'Failed to create payment order.'});
    }
});

app.post('/api/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body.toString())
        .digest('hex');

    if (expectedSignature === razorpay_signature) {
        const job = global.printJobs[razorpay_order_id];
        if (job) {
            job.status = 'paid_and_printing';
            job.pickupCode = generatePickupCode();
            job.paymentId = razorpay_payment_id;
            
            console.log(`✅ Payment successful! Code: ${job.pickupCode} | File: ${job.originalName}`);
            
            printDocument(job.filePath).then(success => {
                if (success) job.status = 'printing_completed';
                else job.status = 'print_failed_needs_manual';
            });

            res.json({ success: true, pickupCode: job.pickupCode });
        } else {
            res.status(404).json({ success: false, message: 'Job not found in system.' });
        }
    } else {
        res.status(400).json({ success: false, message: 'Invalid payment signature.' });
    }
});

app.get('/api/admin/orders', (req, res) => {
    const activeOrders = Object.values(global.printJobs)
        .filter(job => job.razorpayOrderId && job.pickupCode)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
    res.json(activeOrders);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🌐 Xerox Customer Portal: http://localhost:${PORT}`);
    console.log(`⚙️  Admin Dashboard:      http://localhost:${PORT}/admin.html`);
    console.log(`=========================================`);
});
