const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const pidusage = require('pidusage');

class DeploymentService {
    constructor() {
        this.processes = new Map();
    }

    async startProcess(userId, repoId, repoName) {
        const deployDir = path.join(__dirname, '..', 'deployments', userId.toString(), repoName);
        
        try {
            // Initialize logs for this repository
            this.processes.set(repoId, {
                logs: [{
                    type: 'stdout',
                    message: 'Starting deployment process...',
                    timestamp: new Date()
                }],
                stats: {
                    cpu: 0,
                    memory: 0,
                    maxMemory: 512 // Default max memory in MB
                }
            });

            // Read package.json or requirements.txt to determine project type
            const files = await fs.readdir(deployDir);
            let processCommand;
            let processArgs;

            this.addLog(repoId, 'stdout', `Detected files in directory: ${files.join(', ')}`);

            if (files.includes('package.json')) {
                // Node.js project
                const packageJson = JSON.parse(
                    await fs.readFile(path.join(deployDir, 'package.json'), 'utf-8')
                );

                this.addLog(repoId, 'stdout', 'Detected Node.js project');
                const startScript = packageJson.scripts?.start || 'node index.js';
                this.addLog(repoId, 'stdout', `Using start command: ${startScript}`);

                const [cmd, ...args] = startScript.split(' ');
                processCommand = cmd;
                processArgs = args;
            } else if (files.includes('requirements.txt')) {
                // Python project
                const pythonFiles = files.filter(f => f.endsWith('.py'));
                if (pythonFiles.includes('app.py') || pythonFiles.includes('main.py')) {
                    processCommand = 'python';
                    processArgs = [pythonFiles.includes('app.py') ? 'app.py' : 'main.py'];
                    this.addLog(repoId, 'stdout', `Detected Python project, using ${processArgs[0]}`);
                } else {
                    throw new Error('No main Python file found');
                }
            } else {
                throw new Error('Unsupported project type');
            }

            // Kill existing process if it exists
            this.stopProcess(repoId);

            // Get available port
            const port = this.getAvailablePort();
            this.addLog(repoId, 'stdout', `Assigned port: ${port}`);

            // Start new process
            const childProcess = spawn(processCommand, processArgs, {
                cwd: deployDir,
                env: { ...process.env, PORT: port }
            });

            // Update process information
            const processInfo = this.processes.get(repoId);
            processInfo.process = childProcess;
            processInfo.port = port;

            // Handle process output
            childProcess.stdout.on('data', (data) => {
                this.addLog(repoId, 'stdout', data.toString().trim());
            });

            childProcess.stderr.on('data', (data) => {
                this.addLog(repoId, 'stderr', data.toString().trim());
            });

            childProcess.on('error', (error) => {
                this.addLog(repoId, 'stderr', `Process error: ${error.message}`);
            });

            childProcess.on('close', (code) => {
                this.addLog(repoId, code === 0 ? 'stdout' : 'stderr', 
                    `Process exited with code ${code}`);
                // Don't delete the process info so we keep the logs
                if (this.processes.has(repoId)) {
                    const info = this.processes.get(repoId);
                    delete info.process;
                }
            });

            // Start stats monitoring
            this.startStatsMonitoring(repoId, childProcess.pid);

            return {
                success: true,
                port: port
            };
        } catch (error) {
            this.addLog(repoId, 'stderr', `Deployment error: ${error.message}`);
            console.error('Error starting process:', error);
            return {
                success: false,
                error: error.message
            };
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
        console.log(`[${type}] ${message}`); // Debug logging
        const processInfo = this.processes.get(repoId);
        if (processInfo) {
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
    }

    stopProcess(repoId) {
        const processInfo = this.processes.get(repoId);
        if (processInfo) {
            // Clear stats monitoring interval
            if (processInfo.statsInterval) {
                clearInterval(processInfo.statsInterval);
                delete processInfo.statsInterval;
            }

            // Kill the process if it exists
            if (processInfo.process) {
                this.addLog(repoId, 'stdout', 'Stopping process...');
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
}

module.exports = new DeploymentService(); 