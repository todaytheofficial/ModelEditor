const express = require('express');
const path = require('path');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- НАСТРОЙКА БАЗЫ ДАННЫХ (SQLite) ---
const db = new Database('database.db');

// Создаем таблицы, если их нет
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
`);

// --- СОЗДАНИЕ АДМИНА ПРИ ЗАПУСКЕ ---
const ADMIN_USER = "Today_Idk";
const ADMIN_PASS = "secretpassword)_(&@#$#(@*)$%&@#*^%&@*#(%^@#(*756(^%@&#%@#^&%@("; // ПАРОЛЬ ПО УМОЛЧАНИЮ

const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
if (!stmt.get(ADMIN_USER)) {
    const hash = bcrypt.hashSync(ADMIN_PASS, 10);
    const insert = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');
    insert.run(ADMIN_USER, hash, 'admin');
    console.log(`[INFO] Создан аккаунт админа: ${ADMIN_USER} / ${ADMIN_PASS}`);
}

// --- НАСТРОЙКИ SERVER ---
const UPLOAD_DIR = 'public/uploads';
const fs = require('fs');
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

// Сессии (для входа в систему)
app.use(session({
    secret: 'super_secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 часа
}));

// --- ROUTES ---

// Главная
app.get('/', (req, res) => {
    const posts = db.prepare('SELECT * FROM posts ORDER BY id DESC').all();
    res.render('index', { 
        user: req.session.user, 
        updates: posts 
    });
});

// Регистрация
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const insert = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
        insert.run(username, hash);
        req.session.user = { username, role: 'user' };
        res.redirect('/');
    } catch (e) {
        res.send('<script>alert("Такой пользователь уже существует!"); window.location.href="/";</script>');
    }
});

// Вход
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = { username: user.username, role: user.role };
        res.redirect('/');
    } else {
        res.send('<script>alert("Неверный логин или пароль"); window.location.href="/";</script>');
    }
});

// Выход
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Админка (Только для админа)
app.get('/admin', (req, res) => {
    if (req.session.user && req.session.user.role === 'admin') {
        res.send(`
            <link rel="stylesheet" href="/style.css">
            <div class="container" style="margin-top:50px">
                <h1>Admin Panel: ${req.session.user.username}</h1>
                <a href="/" style="color:white">Back to Home</a>
                <hr>
                <form action="/add-post" method="POST" enctype="multipart/form-data" class="post" style="flex-direction:column; padding:30px; gap:15px">
                    <h2>New Update</h2>
                    <input name="title" placeholder="Update Title" required style="padding:10px">
                    <input name="version" placeholder="Version (e.g. 1.2)" required style="padding:10px">
                    <textarea name="text" placeholder="Changes..." rows="5" style="padding:10px"></textarea>
                    <input type="file" name="updateZip" accept=".zip" required>
                    <button type="submit" class="download-btn">Publish</button>
                </form>
            </div>
        `);
    } else {
        res.status(403).send("Access Denied.");
    }
});

// Публикация поста
app.post('/add-post', upload.single('updateZip'), (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send("Forbidden");
    
    const newPost = {
        title: req.body.title,
        version: req.body.version,
        text: req.body.text,
        date: new Date().toLocaleDateString('en-US'),
        tag: "Update",
        downloadUrl: `/uploads/${req.file.filename}`
    };
    
    const insert = db.prepare('INSERT INTO posts (title, version, text, date, tag, downloadUrl) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(newPost.title, newPost.version, newPost.text, newPost.date, newPost.tag, newPost.downloadUrl);

    io.emit('newPost', newPost);
    res.redirect('/');
});

// API для C++
app.get('/api/version', (req, res) => {
    const post = db.prepare('SELECT * FROM posts ORDER BY id DESC LIMIT 1').get();
    if (post) {
        res.json({ version: post.version, title: post.title, url: post.downloadUrl });
    } else {
        res.json({ version: "0.0", url: "" });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});