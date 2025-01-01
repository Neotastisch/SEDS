const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const simpleGit = require('simple-git');

class DeploymentService {
    constructor(db) {
        this.db = db;
        this.processes = new Map();
        this.logs = new Map();
        this.autoStart = true; // Default to true
        
        // Check Docker and initialize
        this.checkDockerRequirement().then(() => {
            this.initializeRepositories().catch(err => {
                console.error('Error initializing repositories:', err);
            });
        });
    }

    async checkDockerRequirement() {
        try {
            await new Promise((resolve, reject) => {
                const dockerVersion = spawn('docker', ['--version']);
                dockerVersion.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error('Docker command failed'));
                });
                dockerVersion.on('error', (err) => {
                    if (err.code === 'ENOENT') {
                        reject(new Error('Docker is not installed or not in PATH'));
                    } else {
                        reject(err);
                    }
                });
            });
            console.log('Docker is available');
        } catch (error) {
            console.error('Docker is required but not available:', error.message);
            console.error('Please install Docker and make sure it is running');
            process.exit(1); // Exit the application if Docker is not available
        }
    }

    // Database helper methods remain the same
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

            // Stop existing container if running
            await this.stopProcess(repoId);

            // Pull latest changes if requested
            if (shouldPull) {
                this.addLog(repoId, 'info', 'Pulling latest changes from repository...');
                await this.pullRepository(repo);
            }

            // Get an available port for internal use
            const internalPort = await this.getAvailablePort();

            // Detect project type and get Dockerfile content
            const projectType = await this.detectProjectType(repo.deploy_path, repoId);
            const dockerfileContent = this.generateDockerfile(projectType);
            
            // Write Dockerfile
            this.addLog(repoId, 'info', 'Creating Dockerfile...');
            await fs.writeFile(path.join(repo.deploy_path, 'Dockerfile'), dockerfileContent);

            // Build Docker image
            this.addLog(repoId, 'info', 'Building Docker image (this may take a few minutes)...');
            const containerName = `seds-${repoId}`;
            const imageName = `seds-image-${repoId}`;
            
            try {
                const buildOutput = await this.runDockerCommand(['build', '-t', imageName, repo.deploy_path], repoId);
                this.addLog(repoId, 'info', 'Docker image built successfully');
            } catch (error) {
                this.addLog(repoId, 'error', `Failed to build Docker image: ${error.message}`);
                throw error;
            }

            // Run container
            this.addLog(repoId, 'info', 'Starting container...');
            try {
                await this.runDockerCommand([
                    'run',
                    '-d',
                    '--name', containerName,
                    '-p', `${internalPort}:${projectType.defaultPort}`,
                    '--restart', 'unless-stopped',
                    imageName
                ], repoId);
            } catch (error) {
                this.addLog(repoId, 'error', `Failed to start container: ${error.message}`);
                throw error;
            }

            // Update process info
            const processInfo = this.processes.get(repoId);
            processInfo.containerId = containerName;
            processInfo.port = internalPort;

            // Set up log streaming
            this.setupLogStreaming(repoId, containerName);

            // Start monitoring container stats
            await this.startStatsMonitoring(repoId, containerName);
            
            await this.updateRepositoryStatus(repoId, 'SUCCESS');
            
            this.addLog(repoId, 'info', `Deployment successful. Container running on port ${internalPort}`);
            return true;
        } catch (error) {
            this.addLog(repoId, 'error', `Failed to start process: ${error.message}`);
            await this.updateRepositoryStatus(repoId, 'FAILED');
            throw error;
        }
    }

    async runDockerCommand(args, repoId = null) {
        return new Promise((resolve, reject) => {
            const process = spawn('docker', args);
            let output = '';
            
            if (repoId) {
                process.stdout.on('data', (data) => {
                    const message = data.toString();
                    output += message;
                    this.addLog(repoId, 'stdout', message);
                });

                process.stderr.on('data', (data) => {
                    const message = data.toString();
                    output += message;
                    this.addLog(repoId, 'stderr', message);
                });
            }

            process.on('close', (code) => {
                if (code === 0) resolve(output);
                else reject(new Error(`Docker command failed with code ${code}. Output: ${output}`));
            });

            process.on('error', (err) => {
                if (repoId) {
                    this.addLog(repoId, 'error', `Docker command error: ${err.message}`);
                }
                reject(err);
            });
        });
    }

    setupLogStreaming(repoId, containerId) {
        const logStream = spawn('docker', ['logs', '-f', containerId]);
        
        logStream.stdout.on('data', (data) => {
            this.addLog(repoId, 'stdout', data.toString());
        });

        logStream.stderr.on('data', (data) => {
            this.addLog(repoId, 'stderr', data.toString());
        });

        // Store the log stream for cleanup
        const processInfo = this.processes.get(repoId);
        if (processInfo) {
            processInfo.logStream = logStream;
        }
    }

    async stopProcess(repoId) {
        const processInfo = this.processes.get(repoId);
        if (processInfo) {
            // Clear monitoring intervals and streams
            if (processInfo.statsInterval) {
                clearInterval(processInfo.statsInterval);
                delete processInfo.statsInterval;
            }
            if (processInfo.logStream) {
                processInfo.logStream.kill();
                delete processInfo.logStream;
            }

            const containerName = `seds-${repoId}`;
            try {
                // Check if container exists
                const checkOutput = await this.runDockerCommand(['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.ID}}']);
                
                if (checkOutput.trim()) {
                    // Stop container if it's running
                    try {
                        await this.runDockerCommand(['stop', containerName]);
                    } catch (error) {
                        // Ignore error if container is not running
                    }
                    
                    // Remove container
                    try {
                        await this.runDockerCommand(['rm', '-f', containerName]);
                    } catch (error) {
                        this.addLog(repoId, 'error', `Error removing container: ${error.message}`);
                    }
                }

                // Remove image if it exists
                try {
                    const imageName = `seds-image-${repoId}`;
                    await this.runDockerCommand(['rmi', '-f', imageName]);
                } catch (error) {
                    // Ignore error if image doesn't exist
                }

            } catch (error) {
                this.addLog(repoId, 'error', `Error during cleanup: ${error.message}`);
            }

            // Reset stats
            processInfo.stats = {
                cpu: 0,
                memory: 0,
                maxMemory: 512
            };
            return true;
        }
        return false;
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
            // Clean up any existing containers from previous runs
            await this.cleanupExistingContainers();

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

    async cleanupExistingContainers() {
        try {
            // Get all containers with our prefix
            const output = await this.runDockerCommand(['ps', '-a', '--filter', 'name=seds-', '--format', '{{.Names}}']);
            const containers = output.trim().split('\n').filter(Boolean);

            for (const container of containers) {
                try {
                    // Stop container if running
                    await this.runDockerCommand(['stop', container]);
                } catch (error) {
                    // Ignore error if container is not running
                }

                try {
                    // Remove container
                    await this.runDockerCommand(['rm', '-f', container]);
                } catch (error) {
                    console.error(`Error removing container ${container}:`, error);
                }
            }

            // Clean up images
            try {
                const imageOutput = await this.runDockerCommand(['images', 'seds-image-*', '--format', '{{.Repository}}']);
                const images = imageOutput.trim().split('\n').filter(Boolean);
                
                for (const image of images) {
                    await this.runDockerCommand(['rmi', '-f', image]);
                }
            } catch (error) {
                // Ignore error if no images found
            }
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }

    setAutoStart(enabled) {
        this.autoStart = enabled;
    }

    getStartCommand(projectType, deployPath) {
        switch (projectType.type) {
            case 'nodejs':
                const packageJson = require(path.join(deployPath, 'package.json'));
                const startScript = packageJson.scripts?.start || 'node index.js';
                const [command, ...args] = startScript.split(' ');
                return { command, args };

            case 'python':
                const mainFile = fs.existsSync(path.join(deployPath, 'app.py')) ? 'app.py' : 'main.py';
                return { command: 'python', args: [mainFile] };

            case 'java-maven':
                return { command: 'mvn', args: ['spring-boot:run'] };

            case 'java-gradle':
                return { command: 'gradle', args: ['bootRun'] };

            case 'go':
                return { command: 'go', args: ['run', '.'] };

            default:
                throw new Error('Unsupported project type');
        }
    }

    generateDockerfile(projectType) {
        let dockerfile = '';
        
        switch (projectType.type) {
            case 'nodejs':
                dockerfile = `FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE ${projectType.defaultPort}
ENV PORT=${projectType.defaultPort}
CMD ["npm", "start"]`;
                break;

            case 'python':
                dockerfile = `FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${projectType.defaultPort}
ENV PORT=${projectType.defaultPort}
CMD ["python", "app.py"]`;
                break;

            case 'java-maven':
                dockerfile = `FROM maven:3.8-openjdk-11-slim AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline
COPY src ./src
RUN mvn package -DskipTests

FROM openjdk:11-jre-slim
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE ${projectType.defaultPort}
ENV PORT=${projectType.defaultPort}
CMD ["java", "-jar", "app.jar"]`;
                break;

            case 'java-gradle':
                dockerfile = `FROM gradle:7-jdk11-alpine AS build
WORKDIR /app
COPY build.gradle settings.gradle ./
COPY src ./src
RUN gradle bootJar --no-daemon

FROM openjdk:11-jre-slim
WORKDIR /app
COPY --from=build /app/build/libs/*.jar app.jar
EXPOSE ${projectType.defaultPort}
ENV PORT=${projectType.defaultPort}
CMD ["java", "-jar", "app.jar"]`;
                break;

            case 'go':
                dockerfile = `FROM golang:1.17-alpine AS build
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o main .

FROM alpine:latest
WORKDIR /app
COPY --from=build /app/main .
EXPOSE ${projectType.defaultPort}
ENV PORT=${projectType.defaultPort}
CMD ["./main"]`;
                break;

            default:
                throw new Error('Unsupported project type');
        }

        return dockerfile;
    }

    async startStatsMonitoring(repoId, containerId) {
        const updateStats = async () => {
            try {
                const stats = await this.getDockerStats(containerId);
                const processInfo = this.processes.get(repoId);
                if (processInfo) {
                    processInfo.stats = stats;
                }
            } catch (error) {
                // Container might have stopped
                const processInfo = this.processes.get(repoId);
                if (processInfo) {
                    processInfo.stats = {
                        cpu: 0,
                        memory: 0,
                        maxMemory: 512
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

    async getDockerStats(containerId) {
        return new Promise((resolve, reject) => {
            const statsProcess = spawn('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}},{{.MemUsage}}', containerId]);
            let output = '';

            statsProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            statsProcess.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error('Failed to get container stats'));
                    return;
                }

                const [cpuStr, memStr] = output.trim().split(',');
                const cpu = parseFloat(cpuStr.replace('%', ''));
                const memory = parseInt(memStr.split('/')[0].trim().replace('MiB', ''));
                const maxMemory = parseInt(memStr.split('/')[1].trim().replace('MiB', ''));

                resolve({
                    cpu,
                    memory,
                    maxMemory
                });
            });
        });
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
                if (repoId) {
                    this.addLog(repoId, 'info', 'Detected Node.js project');
                }
                return {
                    type: 'nodejs',
                    defaultPort: 3000
                };
            }
            
            // Check for requirements.txt (Python project)
            if (files.includes('requirements.txt')) {
                const pythonFiles = files.filter(f => f.endsWith('.py'));
                if (pythonFiles.includes('app.py') || pythonFiles.includes('main.py')) {
                    if (repoId) {
                        this.addLog(repoId, 'info', 'Detected Python project');
                    }
                    return {
                        type: 'python',
                        defaultPort: 5000
                    };
                }
            }

            // Check for pom.xml (Java Maven project)
            if (files.includes('pom.xml')) {
                if (repoId) {
                    this.addLog(repoId, 'info', 'Detected Java Maven project');
                }
                return {
                    type: 'java-maven',
                    defaultPort: 8080
                };
            }

            // Check for build.gradle (Java Gradle project)
            if (files.includes('build.gradle')) {
                if (repoId) {
                    this.addLog(repoId, 'info', 'Detected Java Gradle project');
                }
                return {
                    type: 'java-gradle',
                    defaultPort: 8080
                };
            }

            // Check for go.mod (Go project)
            if (files.includes('go.mod')) {
                if (repoId) {
                    this.addLog(repoId, 'info', 'Detected Go project');
                }
                return {
                    type: 'go',
                    defaultPort: 8080
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