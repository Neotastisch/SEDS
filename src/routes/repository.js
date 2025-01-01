const express = require('express');
const router = express.Router();
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs').promises;
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
const DeploymentService = require('../services/deployment');
const deploymentService = new DeploymentService(db);
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');

// Helper function to execute database queries as promises
function dbRun(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbGet(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Middleware to ensure user is authenticated
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

// Helper function to verify webhook signature
function verifyWebhookSignature(payload, signature) {
    if (!signature) return false;
    
    const sig = Buffer.from(signature, 'utf8');
    const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
    const digest = Buffer.from('sha256=' + hmac.update(payload).digest('hex'), 'utf8');
    
    if (sig.length !== digest.length || !crypto.timingSafeEqual(digest, sig)) {
        return false;
    }
    return true;
}

// Helper function to set up GitHub webhook
async function setupWebhook(accessToken, owner, repo, webhookUrl) {
    const octokit = new Octokit({ auth: accessToken });
    
    try {
        // Check if webhook already exists
        const webhooks = await octokit.repos.listWebhooks({
            owner,
            repo
        });

        const existingWebhook = webhooks.data.find(hook => 
            hook.config.url === webhookUrl
        );

        if (existingWebhook) {
            // Update existing webhook
            await octokit.repos.updateWebhook({
                owner,
                repo,
                hook_id: existingWebhook.id,
                config: {
                    url: webhookUrl,
                    content_type: 'json',
                    secret: process.env.GITHUB_WEBHOOK_SECRET,
                    insecure_ssl: '0'
                },
                events: ['push'],
                active: true
            });
        } else {
            // Create new webhook
            await octokit.repos.createWebhook({
                owner,
                repo,
                config: {
                    url: webhookUrl,
                    content_type: 'json',
                    secret: process.env.GITHUB_WEBHOOK_SECRET,
                    insecure_ssl: '0'
                },
                events: ['push'],
                active: true
            });
        }
        
        return true;
    } catch (error) {
        console.error('Error setting up webhook:', error);
        return false;
    }
}

// Route to show add repository form
router.get('/add', ensureAuthenticated, (req, res) => {
    res.render('add-repository');
});

// Route to handle adding a new repository
router.post('/add', ensureAuthenticated, async (req, res) => {
    const { repoUrl } = req.body;
    
    try {
        // Extract owner and repo name from URL
        const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
        if (!match) {
            return res.status(400).json({ error: 'Invalid GitHub repository URL' });
        }

        const [, owner, repoName] = match;

        // Create deployment directory path
        const deployDir = path.join(__dirname, '..', 'deployments', req.user.id.toString(), repoName);

        // Insert repository into database
        const result = await dbRun(
            'INSERT INTO repositories (user_id, repo_name, repo_url, deploy_path, status) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, repoName, repoUrl, deployDir, 'PENDING']
        );

        const repoId = result.lastID;

        // Set up webhook automatically
        const webhookUrl = `${process.env.APP_URL}/repositories/webhook/${repoId}`;
        await setupWebhook(req.user.access_token, owner, repoName, webhookUrl);

        // Clone repository and start deployment
        await deploymentService.cloneAndDeploy(repoId, repoUrl);

        res.json({ success: true, repoId });
    } catch (error) {
        console.error('Error adding repository:', error);
        res.status(500).json({ error: 'Failed to add repository' });
    }
});

// Route to handle deployments
router.post('/deploy/:repoId', ensureAuthenticated, async (req, res) => {
    const { repoId } = req.params;

    try {
        // Get repository information
        const repo = await dbGet(
            'SELECT * FROM repositories WHERE id = ? AND user_id = ?',
            [repoId, req.user.id]
        );

        if (!repo) {
            return res.status(404).json({ error: 'Repository not found' });
        }

        // Update deployment status
        await dbRun(
            'UPDATE repositories SET status = ? WHERE id = ?',
            ['DEPLOYING', repoId]
        );

        // Get deployment directory
        const deployDir = path.join(__dirname, '..', 'deployments', req.user.id.toString(), repo.repo_name);
        const git = simpleGit(deployDir);

        // Pull latest changes
        await git.pull();

        // Get environment variables
        const envVars = await dbAll(
            'SELECT key, value FROM env_variables WHERE repo_id = ?',
            [repoId]
        );

        // Create .env file
        const envContent = envVars.map(({ key, value }) => `${key}=${value}`).join('\n');
        await fs.writeFile(path.join(deployDir, '.env'), envContent);

        // Start the deployment process
        const deployResult = await deploymentService.startProcess(req.user.id, repoId, repo.repo_name);

        if (deployResult.success) {
            // Update deployment status and timestamp
            await dbRun(
                'UPDATE repositories SET status = ?, last_deploy = ? WHERE id = ?',
                ['SUCCESS', new Date().toISOString(), repoId]
            );

            res.json({ 
                success: true,
                port: deployResult.port
            });
        } else {
            throw new Error(deployResult.error);
        }
    } catch (error) {
        console.error('Deployment error:', error);
        
        // Update status to failed
        await dbRun(
            'UPDATE repositories SET status = ? WHERE id = ?',
            ['FAILED', repoId]
        );

        res.status(500).json({ error: 'Deployment failed' });
    }
});

// Route to get deployment logs
router.get('/logs/:repoId', ensureAuthenticated, async (req, res) => {
    const { repoId } = req.params;

    try {
        const repo = await dbGet(
            'SELECT * FROM repositories WHERE id = ? AND user_id = ?',
            [repoId, req.user.id]
        );

        if (!repo) {
            return res.status(404).json({ error: 'Repository not found' });
        }

        res.json(logs || []);
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// Route to get environment variables
router.get('/env/:repoId', ensureAuthenticated, async (req, res) => {
    const { repoId } = req.params;

    try {
        const vars = await dbAll(
            'SELECT key, value FROM env_variables WHERE repo_id = ?',
            [repoId]
        );
        res.json(vars);
    } catch (error) {
        console.error('Error fetching env vars:', error);
        res.status(500).json({ error: 'Failed to fetch environment variables' });
    }
});

// Route to save environment variables
router.post('/env/:repoId', ensureAuthenticated, async (req, res) => {
    const { repoId } = req.params;
    const { vars } = req.body;

    try {
        // Delete existing variables
        await dbRun('DELETE FROM env_variables WHERE repo_id = ?', [repoId]);

        // Insert new variables
        for (const { key, value } of vars) {
            await dbRun(
                'INSERT INTO env_variables (repo_id, key, value) VALUES (?, ?, ?)',
                [repoId, key, value]
            );
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error saving env vars:', error);
        res.status(500).json({ error: 'Failed to save environment variables' });
    }
});

// Route to restart a repository
router.post('/restart/:repoId', ensureAuthenticated, async (req, res) => {
    const { repoId } = req.params;

    try {
        const repo = await dbGet(
            'SELECT * FROM repositories WHERE id = ? AND user_id = ?',
            [repoId, req.user.id]
        );

        if (!repo) {
            return res.status(404).json({ error: 'Repository not found' });
        }

        // Stop the current process
        deploymentService.stopProcess(repoId);

        // Start a new deployment
        const deployResult = await deploymentService.startProcess(req.user.id, repoId, repo.repo_name);

        if (deployResult.success) {
            await dbRun(
                'UPDATE repositories SET status = ?, last_deploy = ? WHERE id = ?',
                ['SUCCESS', new Date().toISOString(), repoId]
            );

            res.json({ 
                success: true,
                port: deployResult.port
            });
        } else {
            throw new Error(deployResult.error);
        }
    } catch (error) {
        console.error('Restart error:', error);
        res.status(500).json({ error: 'Failed to restart repository' });
    }
});

// Route to stop a repository
router.post('/stop/:repoId', ensureAuthenticated, async (req, res) => {
    const { repoId } = req.params;

    try {
        const repo = await dbGet(
            'SELECT * FROM repositories WHERE id = ? AND user_id = ?',
            [repoId, req.user.id]
        );

        if (!repo) {
            return res.status(404).json({ error: 'Repository not found' });
        }

        // Stop the process
        const stopped = deploymentService.stopProcess(repoId);

        if (stopped) {
            await dbRun(
                'UPDATE repositories SET status = ? WHERE id = ?',
                ['STOPPED', repoId]
            );
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Stop error:', error);
        res.status(500).json({ error: 'Failed to stop repository' });
    }
});

// Route to get repository stats
router.get('/stats/:repoId', ensureAuthenticated, async (req, res) => {
    const { repoId } = req.params;

    try {
        const repo = await dbGet(
            'SELECT * FROM repositories WHERE id = ? AND user_id = ?',
            [repoId, req.user.id]
        );

        if (!repo) {
            return res.status(404).json({ error: 'Repository not found' });
        }

        const stats = deploymentService.getProcessStats(repoId);
        res.json(stats);
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Failed to get repository stats' });
    }
});

// Route to delete a repository
router.delete('/:repoId', ensureAuthenticated, async (req, res) => {
    const { repoId } = req.params;

    try {
        // Get repository information
        const repo = await dbGet(
            'SELECT * FROM repositories WHERE id = ? AND user_id = ?',
            [repoId, req.user.id]
        );

        if (!repo) {
            return res.status(404).json({ error: 'Repository not found' });
        }

        // Stop any running process
        deploymentService.stopProcess(repoId);

        // Delete environment variables
        await dbRun('DELETE FROM env_variables WHERE repo_id = ?', [repoId]);

        // Delete repository from database
        await dbRun('DELETE FROM repositories WHERE id = ?', [repoId]);

        // Delete deployment directory
        const deployDir = path.join(__dirname, '..', 'deployments', req.user.id.toString(), repo.repo_name);
        try {
            await fs.rm(deployDir, { recursive: true, force: true });
        } catch (error) {
            console.error('Error deleting deployment directory:', error);
            // Continue even if directory deletion fails
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete repository' });
    }
});

// Route to handle GitHub webhooks
router.post('/webhook/:repoId', async (req, res) => {
    const { repoId } = req.params;
    const event = req.headers['x-github-event'];
    const signature = req.headers['x-hub-signature-256'];
    const payload = JSON.stringify(req.body);

    try {
        // Verify webhook signature
        if (!verifyWebhookSignature(payload, signature)) {
            console.error('Invalid webhook signature');
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        // Get repository information
        const repo = await dbGet('SELECT * FROM repositories WHERE id = ?', [repoId]);
        
        if (!repo) {
            return res.status(404).json({ error: 'Repository not found' });
        }

        // Only handle push events
        if (event !== 'push') {
            return res.json({ message: 'Event ignored' });
        }

        // Update deployment status
        await dbRun(
            'UPDATE repositories SET status = ? WHERE id = ?',
            ['DEPLOYING', repoId]
        );

        // Stop existing process if running
        deploymentService.stopProcess(repoId);

        // Get deployment directory
        const deployDir = path.join(__dirname, '..', 'deployments', repo.user_id.toString(), repo.repo_name);
        const git = simpleGit(deployDir);

        try {
            // Pull latest changes
            await git.pull();
            
            // Get environment variables
            const envVars = await dbAll(
                'SELECT key, value FROM env_variables WHERE repo_id = ?',
                [repoId]
            );

            // Create .env file
            const envContent = envVars.map(({ key, value }) => `${key}=${value}`).join('\n');
            await fs.writeFile(path.join(deployDir, '.env'), envContent);

            // Start the deployment process
            await deploymentService.startProcess(repoId, false);

            await dbRun(
                'UPDATE repositories SET status = ?, last_deploy = ? WHERE id = ?',
                ['SUCCESS', new Date().toISOString(), repoId]
            );

            res.json({ success: true, message: 'Deployment successful' });
        } catch (error) {
            console.error('Deployment error:', error);
            await dbRun(
                'UPDATE repositories SET status = ? WHERE id = ?',
                ['FAILED', repoId]
            );
            throw error;
        }
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed', details: error.message });
    }
});

// Start repository (using existing files)
router.post('/start/:repoId', async (req, res) => {
    try {
        const repoId = req.params.repoId;
        const repo = await deploymentService.getRepository(repoId);
        if (!repo) {
            return res.status(404).json({ success: false, error: 'Repository not found' });
        }

        await deploymentService.startProcess(repoId, false); // false means don't pull new changes
        res.json({ success: true });
    } catch (error) {
        console.error('Error starting repository:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Re-deploy repository (pull and start)
router.post('/deploy/:repoId', async (req, res) => {
    try {
        const repoId = req.params.repoId;
        const repo = await deploymentService.getRepository(repoId);
        if (!repo) {
            return res.status(404).json({ success: false, error: 'Repository not found' });
        }

        await deploymentService.startProcess(repoId, true); // true means pull new changes
        res.json({ success: true });
    } catch (error) {
        console.error('Error deploying repository:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Route to get repository port
router.get('/port/:repoId', ensureAuthenticated, async (req, res) => {
    const { repoId } = req.params;

    try {
        const repo = await dbGet(
            'SELECT * FROM repositories WHERE id = ? AND user_id = ?',
            [repoId, req.user.id]
        );

        if (!repo) {
            return res.status(404).json({ error: 'Repository not found' });
        }

        const port = deploymentService.getProcessPort(repoId);
        res.json({ port });
    } catch (error) {
        console.error('Error getting repository port:', error);
        res.status(500).json({ error: 'Failed to get repository port' });
    }
});

module.exports = router; 