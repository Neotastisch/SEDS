const express = require('express');
const router = express.Router();
const DeploymentService = require('../services/deployment');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
const deploymentService = new DeploymentService(db);

// Helper function to execute database queries as promises
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

// Route to show monitoring page
router.get('/', ensureAuthenticated, (req, res) => {
    res.render('monitoring');
});

// Route to get monitoring statistics
router.get('/stats', ensureAuthenticated, async (req, res) => {
    try {
        // Get all repositories for the user
        const repositories = await dbAll(
            'SELECT * FROM repositories WHERE user_id = ?',
            [req.user.id]
        );

        // Get process stats for each repository
        const repoStats = repositories.map(repo => {
            const stats = deploymentService.getProcessStats(repo.id);
            return {
                id: repo.id,
                name: repo.repo_name,
                url: repo.repo_url,
                status: repo.status,
                lastDeploy: repo.last_deploy,
                cpu: stats.cpu,
                memory: stats.memory
            };
        });

        // Calculate system-wide statistics
        const activeDeployments = repoStats.filter(repo => 
            repo.status === 'SUCCESS' && (repo.cpu > 0 || repo.memory > 0)
        ).length;

        const totalMemory = repoStats.reduce((sum, repo) => sum + repo.memory, 0);
        
        const activeRepos = repoStats.filter(repo => repo.cpu > 0);
        const averageCpu = activeRepos.length > 0
            ? Math.round(activeRepos.reduce((sum, repo) => sum + repo.cpu, 0) / activeRepos.length)
            : 0;

        res.json({
            activeDeployments,
            totalMemory,
            averageCpu,
            repositories: repoStats
        });
    } catch (error) {
        console.error('Error fetching monitoring stats:', error);
        res.status(500).json({ error: 'Failed to fetch monitoring statistics' });
    }
});

module.exports = router; 