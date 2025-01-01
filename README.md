# EzDeploy

A simple GitHub-based deployment system that allows users to easily deploy their projects with one click.

## Features

- GitHub OAuth authentication
- Support for both public and private repositories
- Automatic deployment on repository updates
- Environment variable management
- Support for Node.js and Python projects
- Simple deployment logs
- Easy-to-use web interface

## Prerequisites

- Node.js (v14 or higher)
- SQLite3
- Git

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/ezdeploy.git
cd ezdeploy
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with the following content:
```
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
PORT=3000
```

4. Create the `deployments` directory:
```bash
mkdir -p src/deployments
```

5. Start the server:
```bash
npm start
```

The application will be available at `http://localhost:3000`.

## Usage

1. Visit the application URL and log in with your GitHub account.
2. Click "Add Repository" to add a new repository for deployment.
3. Enter the repository URL and submit.
4. Configure environment variables if needed.
5. Click "Deploy" to start the deployment process.

## Project Structure

```
src/
  ├── index.js           # Main application file
  ├── routes/            # Route handlers
  │   └── repository.js  # Repository management routes
  ├── services/          # Business logic
  │   └── deployment.js  # Deployment service
  ├── views/             # EJS templates
  │   ├── index.ejs     # Landing page
  │   ├── login.ejs     # Login page
  │   └── dashboard.ejs # Main dashboard
  └── deployments/       # Directory for deployed projects
```

## Development

To run the application in development mode with auto-reload:

```bash
npm run dev
```

## Security Considerations

- The application uses GitHub OAuth for authentication
- Environment variables are stored securely in the SQLite database
- Each project runs in its own process with isolated environment variables
- Access to repositories is restricted to authenticated users

## Limitations

- Currently supports only Node.js and Python projects
- Basic process management (no containerization)
- Simple port management system
- Local SQLite database (not suitable for production)

## Future Improvements

- Docker support
- Multiple deployment environments
- Advanced logging and monitoring
- Custom domain support
- Horizontal scaling capabilities
- Database migration system 