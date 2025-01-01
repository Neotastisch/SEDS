require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const morgan = require('morgan');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const repositoryRoutes = require('./routes/repository');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new sqlite3.Database('database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

// Initialize database tables
function initializeDatabase() {
  db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      github_id TEXT UNIQUE,
      username TEXT,
      access_token TEXT
    )`);

    // Repositories table
    db.run(`CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      repo_name TEXT,
      repo_url TEXT,
      last_deploy TEXT,
      status TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Environment variables table
    db.run(`CREATE TABLE IF NOT EXISTS env_variables (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER,
      key TEXT,
      value TEXT,
      FOREIGN KEY(repo_id) REFERENCES repositories(id)
    )`);
  });
}

// Middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'your-session-secret',
  resave: false,
  saveUninitialized: false
}));

// Initialize passport
app.use(passport.initialize());
app.use(passport.session());

// Set up view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Passport GitHub strategy
passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: "http://localhost:3000/auth/github/callback"
  },
  function(accessToken, refreshToken, profile, done) {
    // Store user in database
    db.get('SELECT * FROM users WHERE github_id = ?', [profile.id], (err, user) => {
      if (err) return done(err);
      
      if (!user) {
        db.run('INSERT INTO users (github_id, username, access_token) VALUES (?, ?, ?)',
          [profile.id, profile.username, accessToken],
          function(err) {
            if (err) return done(err);
            return done(null, {
              id: this.lastID,
              github_id: profile.id,
              username: profile.username,
              access_token: accessToken
            });
          });
      } else {
        db.run('UPDATE users SET access_token = ? WHERE github_id = ?',
          [accessToken, profile.id]);
        return done(null, user);
      }
    });
  }
));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    done(err, user);
  });
});

// Authentication middleware
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// Routes
app.get('/', (req, res) => {
  res.render('index', { user: req.user });
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.get('/auth/github',
  passport.authenticate('github', { scope: ['repo', 'user'] })
);

app.get('/auth/github/callback',
  passport.authenticate('github', { failureRedirect: '/login' }),
  (req, res) => {
    res.redirect('/dashboard');
  }
);

app.get('/dashboard', ensureAuthenticated, (req, res) => {
  db.all('SELECT * FROM repositories WHERE user_id = ?', [req.user.id], (err, repos) => {
    if (err) {
      console.error('Error fetching repositories:', err);
      repos = [];
    }
    res.render('dashboard', { user: req.user, repos: repos });
  });
});

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

// Repository routes
app.use('/repositories', repositoryRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
}); 