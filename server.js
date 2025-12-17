const express = require('express');
const path = require('path');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const session = require('express-session');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- НАСТРОЙКА БАЗЫ ДАННЫХ ---
const db = new Database('database.db');

// Создаем таблицы (Обновлено: добавлены таблицы для Community)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'user'
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    version TEXT,
    text TEXT,
    date TEXT,
    tag TEXT,
    downloadUrl TEXT
  );
  CREATE TABLE IF NOT EXISTS community_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    content TEXT,
    date TEXT
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER,
    username TEXT,
    text TEXT,
    date TEXT
  );
`);

// --- АДМИН ПРИ ЗАПУСКЕ ---
const ADMIN_USER = "Today_Idk";
const ADMIN_PASS = "secretpassword)_(&@#$#(@*)$%&@#*^%&@*#(%^@#(*756(^%@&#%@#^&%@("; 
const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
if (!stmt.get(ADMIN_USER)) {
    const hash = bcrypt.hashSync(ADMIN_PASS, 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(ADMIN_USER, hash, 'admin');
    console.log(`[INFO] Admin created: ${ADMIN_USER}`);
}

// --- МИДДЛВАРЫ ---
const UPLOAD_DIR = 'public/uploads';
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

app.use(session({
    secret: 'model_editor_secret_2025',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// --- ROUTES ---

// 1. Главная (Dev Blog)
app.get('/', (req, res) => {
    const posts = db.prepare('SELECT * FROM posts ORDER BY id DESC').all();
    res.render('index', { user: req.session.user, updates: posts });
});

// 2. Community Page
app.get('/community', (req, res) => {
    // Получаем посты и сразу подтягиваем комменты для каждого (простой метод)
    const posts = db.prepare('SELECT * FROM community_posts ORDER BY id DESC').all();
    posts.forEach(post => {
        post.comments = db.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY id ASC').all(post.id);
    });
    res.render('community', { user: req.session.user, posts: posts });
});

// 3. Auth
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
        req.session.user = { username, role: 'user' };
        res.redirect('/');
    } catch (e) {
        res.send('<script>alert("User exists!"); window.location.href="/";</script>');
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = { username: user.username, role: user.role };
        res.redirect('/');
    } else {
        res.send('<script>alert("Wrong password"); window.location.href="/";</script>');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// 4. Community Posting
app.post('/community/post', (req, res) => {
    if (!req.session.user) return res.status(403).send("Login required");
    const { content } = req.body;
    const date = new Date().toLocaleString();
    const insert = db.prepare('INSERT INTO community_posts (username, content, date) VALUES (?, ?, ?)');
    const info = insert.run(req.session.user.username, content, date);
    
    const newPost = { id: info.lastInsertRowid, username: req.session.user.username, content, date, comments: [] };
    io.emit('newCommunityPost', newPost);
    res.redirect('/community');
});

app.get('/admin', (req, res) => {
    if (req.session.user && req.session.user.role === 'admin') {
        // Получаем последнюю версию из БД для отображения в админке
        const lastPost = db.prepare('SELECT version FROM posts ORDER BY id DESC LIMIT 1').get();
        const v = lastPost ? lastPost.version : "0.3";
        
        res.render('admin', { 
            user: req.session.user, 
            currentVersion: v // Теперь переменная передана в EJS
        });
    } else {
        res.status(403).send("Denied");
    }
});

app.post('/add-post', upload.single('updateZip'), (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send("Forbidden");
    const newUpdate = {
        title: req.body.title,
        version: req.body.version,
        text: req.body.text,
        date: new Date().toLocaleDateString('en-US'),
        tag: "Update",
        downloadUrl: `/uploads/${req.file.filename}`
    };
    db.prepare('INSERT INTO posts (title, version, text, date, tag, downloadUrl) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newUpdate.title, newUpdate.version, newUpdate.text, newUpdate.date, newUpdate.tag, newUpdate.downloadUrl);
    
    io.emit('newPost', newUpdate);
    res.redirect('/');
});

app.get('/api/version', (req, res) => {
    const post = db.prepare('SELECT * FROM posts ORDER BY id DESC LIMIT 1').get();
    res.json(post ? { version: post.version, url: post.downloadUrl } : { version: "0.0", url: "" });
});

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    console.log('User connected');

    socket.on('sendComment', (data) => {
        if (!data.username || !data.text) return;
        const date = new Date().toLocaleTimeString();
        const insert = db.prepare('INSERT INTO comments (post_id, username, text, date) VALUES (?, ?, ?, ?)');
        insert.run(data.postId, data.username, data.text, date);

        // Рассылаем всем
        io.emit('receiveComment', {
            postId: data.postId,
            username: data.username,
            text: data.text,
            date: date
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}`);
});