const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const http = require('http'); // Required for socket.io
const { Server } = require('socket.io'); // Import socket.io

const app = express();
const server = http.createServer(app); // Create HTTP server
const io = new Server(server); // Initialize socket.io

// --- CONFIGURATION ---
const DATA_FILE = './posts.json';
const UPLOAD_DIR = 'public/uploads';
const ADMIN_IP = "::1"; 

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

const getPosts = () => {
    try {
        if (!fs.existsSync(DATA_FILE)) return [];
        const content = fs.readFileSync(DATA_FILE, 'utf8');
        return content ? JSON.parse(content) : [];
    } catch (e) { return []; }
};

// --- ROUTES ---

app.get('/', (req, res) => {
    res.render('index', { author: "Today_Idk", updates: getPosts() });
});

app.get('/admin', (req, res) => {
    if (req.ip === ADMIN_IP || req.ip.includes("127.0.0.1")) {
        res.send(`
            <link rel="stylesheet" href="/style.css">
            <div class="container" style="margin-top:50px">
                <form action="/add-post" method="POST" enctype="multipart/form-data" class="post" style="flex-direction:column; padding:30px; gap:15px">
                    <h2>ModelEditor Admin Panel</h2>
                    <input name="title" id="title" placeholder="Update Title" required style="padding:10px">
                    <input name="version" id="version" placeholder="Version (e.g. 1.2)" required style="padding:10px">
                    <textarea name="text" id="text" placeholder="What's new?" rows="5" style="padding:10px"></textarea>
                    <input type="file" name="updateZip" accept=".zip" required>
                    <button type="submit">Publish & Broadcast</button>
                </form>
            </div>
        `);
    } else {
        res.status(403).send("Forbidden. IP: " + req.ip);
    }
});

app.post('/add-post', upload.single('updateZip'), (req, res) => {
    if (req.ip !== ADMIN_IP && !req.ip.includes("127.0.0.1")) return res.status(403).send("Forbidden");
    
    const posts = getPosts();
    const newPost = {
        title: req.body.title,
        version: req.body.version,
        text: req.body.text,
        date: new Date().toLocaleDateString('en-US'),
        tag: "Update",
        downloadUrl: `http://localhost:3000/uploads/${req.file.filename}`
    };
    
    posts.unshift(newPost);
    fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2));

    // --- SOCKET.IO BROADCAST ---
    // This sends the new post data to every open browser tab instantly
    io.emit('newPost', newPost);

    res.redirect('/');
});

app.get('/api/version', (req, res) => {
    const posts = getPosts();
    if (posts.length > 0) {
        res.json({ version: posts[0].version, title: posts[0].title, url: posts[0].downloadUrl });
    } else {
        res.json({ version: "1.0", url: "" });
    }
});

// Socket.io Connection Log
io.on('connection', (socket) => {
    console.log('A user connected to live updates');
});

// Use server.listen instead of app.listen!
server.listen(3000, () => {
    console.log('ModelEditor Server running on http://localhost:3000');
});