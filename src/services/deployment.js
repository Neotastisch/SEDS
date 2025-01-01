const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const pidusage = require('pidusage');
const simpleGit = require('simple-git');

class DeploymentService {
    constructor(db) {
        this.db = db;
        this.processes = new Map();
        this.logs = new Map();
        this.autoStart = true; // Default to true
        
        // Initialize logs and process info for existing repositories
        this.initializeRepositories().catch(err => {
            console.error('Error initializing repositories:', err);
        });
    }

    // Helper method to promisify database queries
    dbGet(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    dbAll(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    dbRun(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    }

    async getRepository(repoId) {
        try {
            return await this.dbGet('SELECT * FROM repositories WHERE id = ?', [repoId]);
        } catch (error) {
            console.error('Error getting repository:', error);
            throw error;
        }
    }

    async getAllRepositories() {
        try {
            return await this.dbAll('SELECT * FROM repositories');
        } catch (error) {
            console.error('Error getting all repositories:', error);
            throw error;
        }
    }

    async initializeRepositories() {
        try {
            const repos = await this.getAllRepositories();
            for (const repo of repos) {
                if (!this.logs.has(repo.id)) {
                    this.logs.set(repo.id, []);
                }
                if (!this.processes.has(repo.id)) {
                    this.processes.set(repo.id, {
                        logs: [],
                        stats: {
                            cpu: 0,
                            memory: 0,
                            maxMemory: 512
                        }
                    });
                }
            }
            // Auto-start repositories if enabled
            if (this.autoStart) {
                for (const repo of repos) {
                    await this.startProcess(repo.id, false);
                }
            }
        } catch (error) {
            console.error('Error initializing repositories:', error);
            throw error;
        }
    }

    setAutoStart(enabled) {
        this.autoStart = enabled;
    }

    async startProcess(repoId, shouldPull = false) {
        try {
            const repo = await this.getRepository(repoId);
            if (!repo) {
                throw new Error('Repository not found');
            }

            // Initialize process info if not exists
            if (!this.processes.has(repoId)) {
                this.processes.set(repoId, {
                    logs: [],
                    stats: {
                        cpu: 0,
                        memory: 0,
                        maxMemory: 512
                    }
                });
            }

            this.addLog(repoId, 'info', `Starting deployment process for ${repo.repo_name}`);

            // Stop existing process if running
            await this.stopProcess(repoId);

            // Pull latest changes if requested
            if (shouldPull) {
                this.addLog(repoId, 'info', 'Pulling latest changes from repository...');
                await this.pullRepository(repo);
            }

            // Detect project type and get start command
            const startCommand = await this.detectProjectType(repo.deploy_path, repoId);
            if (!startCommand) {
                throw new Error('Could not determine project type');
            }

            // Get an available port for internal use
            const internalPort = await this.getAvailablePort();
            
            // Set up environment with the internal port
            const env = { 
                ...process.env, 
                PORT: internalPort,
                INTERNAL_PORT: internalPort
            };

            // Start the process
            const childProcess = spawn(startCommand.command, startCommand.args, {
                cwd: repo.deploy_path,
                env: env
            });

            // Update process info with the child process and port
            const processInfo = this.processes.get(repoId);
            processInfo.process = childProcess;
            processInfo.port = internalPort;

            // Handle process output
            childProcess.stdout.on('data', (data) => {
                const output = data.toString();
                this.addLog(repoId, 'stdout', output);
                
                // Try to detect port from application output
                const portMatch = output.match(/(?:listening|running|started).+?(?:port|:)\s*(\d+)/i);
                if (portMatch && portMatch[1]) {
                    const detectedPort = parseInt(portMatch[1]);
                    if (detectedPort !== internalPort) {
                        this.addLog(repoId, 'info', `Detected application trying to use port ${detectedPort}, redirecting to internal port ${internalPort}`);
                    }
                }
            });

            childProcess.stderr.on('data', (data) => {
                this.addLog(repoId, 'stderr', data.toString());
            });

            childProcess.on('error', (error) => {
                this.addLog(repoId, 'error', `Process error: ${error.message}`);
            });

            childProcess.on('exit', (code) => {
                this.addLog(repoId, code === 0 ? 'info' : 'error', 
                    `Process exited with code ${code}`);
                // Don't delete the process info, just remove the process reference
                const processInfo = this.processes.get(repoId);
                if (processInfo) {
                    delete processInfo.process;
                }
            });

            // Start monitoring process stats
            if (childProcess.pid) {
                this.startStatsMonitoring(repoId, childProcess.pid);
            }
            
            // Update repository status
            await this.updateRepositoryStatus(repoId, 'SUCCESS');
            
            this.addLog(repoId, 'info', `Deployment process started successfully on internal port ${internalPort}`);
            return true;
        } catch (error) {
            this.addLog(repoId, 'error', `Failed to start process: ${error.message}`);
            await this.updateRepositoryStatus(repoId, 'FAILED');
            throw error;
        }
    }

    async startStatsMonitoring(repoId, pid) {
        const updateStats = async () => {
            try {
                const stats = await pidusage(pid);
                const processInfo = this.processes.get(repoId);
                if (processInfo) {
                    processInfo.stats = {
                        cpu: Math.round(stats.cpu),
                        memory: Math.round(stats.memory / 1024 / 1024), // Convert to MB
                        maxMemory: processInfo.stats.maxMemory
                    };
                }
            } catch (error) {
                // Process might have ended
                const processInfo = this.processes.get(repoId);
                if (processInfo) {
                    processInfo.stats = {
                        cpu: 0,
                        memory: 0,
                        maxMemory: processInfo.stats.maxMemory
                    };
                }
            }
        };

        // Update stats every 2 seconds
        const statsInterval = setInterval(updateStats, 2000);

        // Store the interval ID for cleanup
        const processInfo = this.processes.get(repoId);
        if (processInfo) {
            processInfo.statsInterval = statsInterval;
        }
    }

    addLog(repoId, type, message) {
        // Initialize process info if not exists
        if (!this.processes.has(repoId)) {
            this.processes.set(repoId, {
                logs: [],
                stats: {
                    cpu: 0,
                    memory: 0,
                    maxMemory: 512
                }
            });
        }

        const processInfo = this.processes.get(repoId);
        processInfo.logs.push({
            type,
            message: message.toString(),
            timestamp: new Date()
        });

        // Keep only last 100 log entries
        if (processInfo.logs.length > 100) {
            processInfo.logs.shift();
        }
    }

    stopProcess(repoId) {
        const processInfo = this.processes.get(repoId);
        if (processInfo && processInfo.process) {
            // Clear stats monitoring interval
            if (processInfo.statsInterval) {
                clearInterval(processInfo.statsInterval);
                delete processInfo.statsInterval;
            }

            // Kill the process
            this.addLog(repoId, 'info', 'Stopping process...');
            processInfo.process.kill();
            delete processInfo.process;

            // Reset stats
            processInfo.stats = {
                cpu: 0,
                memory: 0,
                maxMemory: processInfo.stats.maxMemory
            };
            return true;
        }
        return false;
    }

    getLogs(repoId) {
        const processInfo = this.processes.get(repoId);
        return processInfo ? processInfo.logs : [];
    }

    getProcessInfo(repoId) {
        return this.processes.get(repoId);
    }

    getAvailablePort() {
        // Simple port management - start from 3001 and increment
        const usedPorts = Array.from(this.processes.values())
            .map(p => p.port)
            .filter(p => p !== undefined);
        let port = 3001;
        while (usedPorts.includes(port)) {
            port++;
        }
        return port;
    }

    getProcessStats(repoId) {
        const processInfo = this.processes.get(repoId);
        if (processInfo && processInfo.stats) {
            return processInfo.stats;
        }
        return {
            cpu: 0,
            memory: 0,
            maxMemory: 512
        };
    }

    async updateRepositoryStatus(repoId, status) {
        try {
            await this.dbRun(
                'UPDATE repositories SET status = ? WHERE id = ?',
                [status, repoId]
            );
        } catch (error) {
            console.error('Error updating repository status:', error);
            throw error;
        }
    }

    async cloneAndDeploy(repoId, repoUrl) {
        try {
            const repo = await this.getRepository(repoId);
            if (!repo) {
                throw new Error('Repository not found');
            }

            // Initialize logs
            if (!this.logs.has(repoId)) {
                this.logs.set(repoId, []);
            }

            this.addLog(repoId, 'info', 'Starting repository setup...');

            // Create deployment directory
            const deployDir = repo.deploy_path;
            await fs.mkdir(deployDir, { recursive: true });

            // Clone repository
            this.addLog(repoId, 'info', 'Cloning repository...');
            const git = simpleGit(deployDir);
            await git.clone(repoUrl, '.');

            // Start the deployment process
            this.addLog(repoId, 'info', 'Starting initial deployment...');
            await this.startProcess(repoId, false);

            return true;
        } catch (error) {
            this.addLog(repoId, 'error', `Setup failed: ${error.message}`);
            await this.updateRepositoryStatus(repoId, 'FAILED');
            throw error;
        }
    }

    async pullRepository(repo) {
        try {
            const git = simpleGit(repo.deploy_path);
            await git.pull();
            return true;
        } catch (error) {
            console.error('Error pulling repository:', error);
            throw error;
        }
    }

    async detectProjectType(deployPath, repoId) {
        try {
            const files = await fs.readdir(deployPath);
            
            // Check for package.json (Node.js project)
            if (files.includes('package.json')) {
                const packageJson = JSON.parse(
                    await fs.readFile(path.join(deployPath, 'package.json'), 'utf-8')
                );

                if (repoId) {
                    this.addLog(repoId, 'info', 'Detected Node.js project');
                }
                
                // Use the start script from package.json or default to node index.js
                const startScript = packageJson.scripts?.start || 'node index.js';
                if (repoId) {
                    this.addLog(repoId, 'info', `Using start command: ${startScript}`);
                }

                const [command, ...args] = startScript.split(' ');
                return { command, args };
            }
            
            // Check for requirements.txt (Python project)
            if (files.includes('requirements.txt')) {
                const pythonFiles = files.filter(f => f.endsWith('.py'));
                if (pythonFiles.includes('app.py') || pythonFiles.includes('main.py')) {
                    if (repoId) {
                        this.addLog(repoId, 'info', 'Detected Python project');
                    }
                    const mainFile = pythonFiles.includes('app.py') ? 'app.py' : 'main.py';
                    return {
                        command: 'python',
                        args: [mainFile]
                    };
                }
            }

            // Check for pom.xml (Java Maven project)
            if (files.includes('pom.xml')) {
                if (repoId) {
                    this.addLog(repoId, 'info', 'Detected Java Maven project');
                }
                return {
                    command: 'mvn',
                    args: ['spring-boot:run']
                };
            }

            // Check for build.gradle (Java Gradle project)
            if (files.includes('build.gradle')) {
                if (repoId) {
                    this.addLog(repoId, 'info', 'Detected Java Gradle project');
                }
                return {
                    command: 'gradle',
                    args: ['bootRun']
                };
            }

            // Check for go.mod (Go project)
            if (files.includes('go.mod')) {
                if (repoId) {
                    this.addLog(repoId, 'info', 'Detected Go project');
                }
                return {
                    command: 'go',
                    args: ['run', '.']
                };
            }

            throw new Error('Unsupported project type');
        } catch (error) {
            console.error('Error detecting project type:', error);
            throw error;
        }
    }

    getProcessPort(repoId) {
        const processInfo = this.processes.get(repoId);
        return processInfo ? processInfo.port : null;
    }
}

module.exports = DeploymentService; 